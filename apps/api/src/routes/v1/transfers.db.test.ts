// Integration tests against a real local Supabase stack (Docker).
// Gated: RUN_DB_TESTS=1. Proves at the DATABASE level that the slice-4 RPCs
// are atomic and exactly-once, that quote consumption wins races, that terms
// are frozen, and that RLS scopes reads — independent of the service layer.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Client } from 'pg'

const runDb = process.env.RUN_DB_TESTS === '1'

const DB_URL = process.env.TEST_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

const USER_A = '00000000-0000-4000-8000-00000000003a'
const USER_B = '00000000-0000-4000-8000-00000000003b'

const FUNDED_ENTRIES = JSON.stringify([
  { account_code: 'funding_receivable', direction: 'debit', amount_minor: 20000, currency: 'USD' },
  { account_code: 'transfer_payable', direction: 'credit', amount_minor: 19801, currency: 'USD' },
  { account_code: 'fee_revenue', direction: 'credit', amount_minor: 199, currency: 'USD' },
])

const DISCLOSURE = JSON.stringify({ version: 1, amounts: { totalMinor: 20000 } })

describe.skipIf(!runDb)('transfers core (integration, local Supabase)', () => {
  let db: Client

  const asRole = async (
    role: 'authenticated' | 'anon',
    sub: string | null,
    sql: string,
    params: unknown[] = [],
  ) => {
    await db.query('begin')
    try {
      await db.query(`set local role ${role}`)
      if (sub) {
        await db.query(`select set_config('request.jwt.claims', $1, true)`, [
          JSON.stringify({ sub, role }),
        ])
      }
      return await db.query(sql, params)
    } finally {
      await db.query('rollback')
    }
  }

  const seedQuote = async (userId: string, minutesToExpiry = 15): Promise<string> => {
    const recipient = await db.query(
      `insert into public.recipients (user_id, first_name, last_name, relationship, country)
       values ($1, 'Ana', 'García López', 'mother', 'MX') returning id`,
      [userId],
    )
    const destination = await db.query(
      `insert into public.payout_destinations (recipient_id, method, currency, details)
       values ($1, 'bank_account', 'MXN', '{}') returning id`,
      [recipient.rows[0].id],
    )
    const quote = await db.query(
      `insert into public.quotes (user_id, payout_destination_id, send_amount_minor, send_currency,
         receive_amount_minor, receive_currency, fee_amount_minor, fee_currency,
         fx_rate, source_rate, fx_rate_at, expires_at)
       values ($1, $2, 19801, 'USD', 396014, 'MXN', 199, 'USD', 19.9997, 20.100251, now(),
         now() + ($3 || ' minutes')::interval) returning id`,
      [userId, destination.rows[0].id, String(minutesToExpiry)],
    )
    return quote.rows[0].id
  }

  const createTransfer = async (quoteId: string, userId: string, key?: string) => {
    const res = await db.query(
      `select public.create_transfer_from_quote($1, $2, $3, 'es', $4::jsonb) as result`,
      [quoteId, userId, key ?? `bridge-key-${quoteId}`, DISCLOSURE],
    )
    return res.rows[0].result as { transfer: { id: string }; disclosure: { id: string } }
  }

  const fundTransfer = (transferId: string) =>
    db.query(
      `select public.transition_transfer($1, 'PENDING_PAYMENT', 'FUNDED', 'webhook:funding',
        'payment initiated', '{}'::jsonb, 'transfer FUNDED', $2::jsonb,
        now(), now() + interval '30 minutes', 'mockpay_1')`,
      [transferId, FUNDED_ENTRIES],
    )

  beforeAll(async () => {
    db = new Client({ connectionString: DB_URL })
    await db.connect()
    await db.query(
      `insert into auth.users (id, phone) values ($1, '15550000031'), ($2, '15550000032')
       on conflict (id) do nothing`,
      [USER_A, USER_B],
    )
  })

  afterAll(async () => {
    await db.query(
      `truncate table public.ledger_entries, public.ledger_transactions,
       public.idempotency_keys, public.disputes, public.disclosures,
       public.payment_events, public.transfer_transitions, public.transfers,
       public.quotes, public.payout_destinations, public.recipients`,
    )
    await db.query('delete from auth.users where id in ($1, $2)', [USER_A, USER_B])
    await db.end()
  })

  beforeEach(async () => {
    await db.query(
      `truncate table public.ledger_entries, public.ledger_transactions,
       public.idempotency_keys, public.disputes, public.disclosures,
       public.payment_events, public.transfer_transitions, public.transfers,
       public.quotes, public.payout_destinations, public.recipients`,
    )
  })

  describe('create_transfer_from_quote', () => {
    it('consumes the quote and creates transfer + transition + disclosure atomically', async () => {
      const quoteId = await seedQuote(USER_A)
      const { transfer, disclosure } = await createTransfer(quoteId, USER_A)

      const quote = await db.query('select status from public.quotes where id = $1', [quoteId])
      expect(quote.rows[0].status).toBe('consumed')

      const row = await db.query('select * from public.transfers where id = $1', [transfer.id])
      expect(row.rows[0]).toMatchObject({
        user_id: USER_A,
        quote_id: quoteId,
        state: 'PENDING_PAYMENT',
        send_amount_minor: '19801',
        receive_amount_minor: '396014',
        fee_amount_minor: '199',
        fx_rate: '19.9997',
        funding_cleared: false,
      })

      const transitions = await db.query(
        'select from_state, to_state, actor from public.transfer_transitions where transfer_id = $1',
        [transfer.id],
      )
      expect(transitions.rows).toEqual([
        { from_state: null, to_state: 'PENDING_PAYMENT', actor: 'user' },
      ])

      const disc = await db.query(
        'select type, locale from public.disclosures where id = $1 and transfer_id = $2',
        [disclosure.id, transfer.id],
      )
      expect(disc.rows[0]).toEqual({ type: 'prepayment', locale: 'es' })
    })

    it('lets exactly one of two concurrent creates win', async () => {
      const quoteId = await seedQuote(USER_A)
      const db2 = new Client({ connectionString: DB_URL })
      await db2.connect()
      try {
        const attempt = (client: Client, key: string) =>
          client
            .query(
              `select public.create_transfer_from_quote($1, $2, $3, 'en', $4::jsonb)`,
              [quoteId, USER_A, key, DISCLOSURE],
            )
            .then(() => 'won')
            .catch((e: { message: string }) => e.message)

        const results = await Promise.all([attempt(db, 'race-key-1'), attempt(db2, 'race-key-2')])
        expect(results.filter((r) => r === 'won')).toHaveLength(1)
        expect(results.find((r) => r !== 'won')).toContain('quote_consumed')

        const count = await db.query('select count(*)::int as n from public.transfers')
        expect(count.rows[0].n).toBe(1)
      } finally {
        await db2.end()
      }
    })

    it('rejects a lapsed quote with quote_expired and settles its status', async () => {
      // expires_at is frozen by the quotes terms trigger, so seed the lapsed
      // quote directly (created in the past, expired one second ago)
      const templateId = await seedQuote(USER_A)
      const lapsed = await db.query(
        `insert into public.quotes (user_id, payout_destination_id, send_amount_minor, send_currency,
           receive_amount_minor, receive_currency, fee_amount_minor, fee_currency,
           fx_rate, source_rate, fx_rate_at, expires_at, created_at)
         select user_id, payout_destination_id, send_amount_minor, send_currency,
           receive_amount_minor, receive_currency, fee_amount_minor, fee_currency,
           fx_rate, source_rate, fx_rate_at, now() - interval '1 second', now() - interval '10 minutes'
         from public.quotes where id = $1 returning id`,
        [templateId],
      )
      const lapsedId = lapsed.rows[0].id

      await expect(createTransfer(lapsedId, USER_A)).rejects.toThrow('quote_expired')
      // the raise aborts the whole tx, so the row stays 'active' (lapsed);
      // derived-expiry on read + the slice-5 sweep own settling
      const status = await db.query('select status from public.quotes where id = $1', [lapsedId])
      expect(status.rows[0].status).toBe('active')
      const count = await db.query('select count(*)::int as n from public.transfers')
      expect(count.rows[0].n).toBe(0)
    })

    it("404s another user's quote as quote_not_found", async () => {
      const quoteId = await seedQuote(USER_A)
      await expect(createTransfer(quoteId, USER_B)).rejects.toThrow('quote_not_found')
    })

    it('enforces single-use via transfers.quote_id UNIQUE even on direct insert', async () => {
      const quoteId = await seedQuote(USER_A)
      const { transfer } = await createTransfer(quoteId, USER_A)
      expect(transfer.id).toBeTruthy()

      await expect(
        db.query(
          `insert into public.transfers (user_id, payout_destination_id, quote_id,
             send_amount_minor, send_currency, receive_amount_minor, receive_currency,
             fee_amount_minor, fee_currency, fx_rate, fx_rate_at, idempotency_key)
           select user_id, payout_destination_id, quote_id, send_amount_minor, send_currency,
             receive_amount_minor, receive_currency, fee_amount_minor, fee_currency,
             fx_rate, fx_rate_at, 'other-key' from public.transfers where id = $1`,
          [transfer.id],
        ),
      ).rejects.toMatchObject({ code: '23505' })
    })
  })

  describe('transition_transfer', () => {
    it('FUNDED: state + transition + ledger batch commit together, exactly once under replay', async () => {
      const quoteId = await seedQuote(USER_A)
      const { transfer } = await createTransfer(quoteId, USER_A)

      await fundTransfer(transfer.id)

      const row = await db.query(
        'select state, payment_at, cancelable_until, funding_payment_ref from public.transfers where id = $1',
        [transfer.id],
      )
      expect(row.rows[0].state).toBe('FUNDED')
      expect(row.rows[0].payment_at).not.toBeNull()
      expect(row.rows[0].funding_payment_ref).toBe('mockpay_1')
      const windowMs =
        new Date(row.rows[0].cancelable_until).getTime() - new Date(row.rows[0].payment_at).getTime()
      expect(windowMs).toBe(30 * 60 * 1000)

      // replay the identical webhook delivery
      await fundTransfer(transfer.id)

      const transitions = await db.query(
        `select count(*)::int as n from public.transfer_transitions
         where transfer_id = $1 and to_state = 'FUNDED'`,
        [transfer.id],
      )
      expect(transitions.rows[0].n).toBe(1)

      const ledgerTx = await db.query(
        'select count(*)::int as n from public.ledger_transactions where transfer_id = $1',
        [transfer.id],
      )
      expect(ledgerTx.rows[0].n).toBe(1)
    })

    it('posts the correct FUNDED balances', async () => {
      const quoteId = await seedQuote(USER_A)
      const { transfer } = await createTransfer(quoteId, USER_A)
      await fundTransfer(transfer.id)

      const balance = async (code: string) => {
        const res = await db.query('select amount_minor from public.ledger_account_balance($1)', [
          code,
        ])
        return Number(res.rows[0].amount_minor)
      }
      expect(await balance('funding_receivable')).toBe(20000)
      expect(await balance('transfer_payable')).toBe(19801)
      expect(await balance('fee_revenue')).toBe(199)
    })

    it('raises transition_conflict when the from_state no longer matches', async () => {
      const quoteId = await seedQuote(USER_A)
      const { transfer } = await createTransfer(quoteId, USER_A)
      await fundTransfer(transfer.id)

      await expect(
        db.query(
          `select public.transition_transfer($1, 'PENDING_PAYMENT', 'PAYMENT_FAILED', 'webhook:funding')`,
          [transfer.id],
        ),
      ).rejects.toThrow('transition_conflict')
    })

    it('rejects unknown transfers and 12th states', async () => {
      await expect(
        db.query(
          `select public.transition_transfer('00000000-0000-4000-8000-0000000000ff',
             'PENDING_PAYMENT', 'FUNDED', 'system')`,
        ),
      ).rejects.toThrow('transfer_not_found')

      const quoteId = await seedQuote(USER_A)
      const { transfer } = await createTransfer(quoteId, USER_A)
      await expect(
        db.query(
          `select public.transition_transfer($1, 'PENDING_PAYMENT', 'TELEPORTED', 'system')`,
          [transfer.id],
        ),
      ).rejects.toMatchObject({ code: '23514' })
    })
  })

  describe('integrity', () => {
    it('freezes transfer terms; lifecycle columns stay mutable', async () => {
      const quoteId = await seedQuote(USER_A)
      const { transfer } = await createTransfer(quoteId, USER_A)

      for (const mutation of [
        `send_amount_minor = 1`,
        `fee_amount_minor = 0`,
        `fx_rate = 21.0`,
        `quote_id = '00000000-0000-4000-8000-0000000000aa'`,
        `idempotency_key = 'swapped'`,
      ]) {
        await expect(
          db.query(`update public.transfers set ${mutation} where id = $1`, [transfer.id]),
        ).rejects.toThrow('immutable')
      }

      await db.query(`update public.transfers set funding_cleared = true where id = $1`, [
        transfer.id,
      ])
      const row = await db.query(
        'select funding_cleared from public.transfers where id = $1',
        [transfer.id],
      )
      expect(row.rows[0].funding_cleared).toBe(true)
    })

    it('keeps transitions and disclosures append-only', async () => {
      const quoteId = await seedQuote(USER_A)
      const { transfer, disclosure } = await createTransfer(quoteId, USER_A)

      await expect(
        db.query(`update public.transfer_transitions set actor = 'hacked' where transfer_id = $1`, [
          transfer.id,
        ]),
      ).rejects.toThrow('append-only')
      await expect(
        db.query(`delete from public.transfer_transitions where transfer_id = $1`, [transfer.id]),
      ).rejects.toThrow('append-only')
      await expect(
        db.query(`update public.disclosures set content = '{}'::jsonb where id = $1`, [
          disclosure.id,
        ]),
      ).rejects.toThrow('append-only')
    })

    it('enforces the new ledger FK', async () => {
      await expect(
        db.query(
          `insert into public.ledger_transactions (transfer_id, transition, idempotency_key, description)
           values ('00000000-0000-4000-8000-0000000000ee', 'FUNDED', 'fk-probe', 'orphan probe')`,
        ),
      ).rejects.toMatchObject({ code: '23503' })
    })
  })

  describe('row level security', () => {
    it('owner reads own transfer + disclosure; others and anon see nothing', async () => {
      const quoteId = await seedQuote(USER_A)
      const { transfer } = await createTransfer(quoteId, USER_A)

      const asA = await asRole('authenticated', USER_A, 'select id from public.transfers')
      expect(asA.rows).toEqual([{ id: transfer.id }])
      const discA = await asRole('authenticated', USER_A, 'select type from public.disclosures')
      expect(discA.rows).toEqual([{ type: 'prepayment' }])

      const asB = await asRole('authenticated', USER_B, 'select id from public.transfers')
      expect(asB.rows).toEqual([])
      const asAnon = await asRole('anon', null, 'select id from public.transfers')
      expect(asAnon.rows).toEqual([])
    })

    it('hides transitions and idempotency keys from clients entirely', async () => {
      const quoteId = await seedQuote(USER_A)
      await createTransfer(quoteId, USER_A)
      await db.query(
        `insert into public.idempotency_keys (key, user_id, endpoint, request_hash)
         values ('k1', $1, 'POST /v1/transfers', 'h1')`,
        [USER_A],
      )

      const transitions = await asRole(
        'authenticated',
        USER_A,
        'select id from public.transfer_transitions',
      )
      expect(transitions.rows).toEqual([])
      const keys = await asRole('authenticated', USER_A, 'select id from public.idempotency_keys')
      expect(keys.rows).toEqual([])
    })

    it('denies the RPCs to authenticated clients', async () => {
      const quoteId = await seedQuote(USER_A)
      await expect(
        asRole(
          'authenticated',
          USER_A,
          `select public.create_transfer_from_quote($1, $2, 'k', 'en', '{}'::jsonb)`,
          [quoteId, USER_A],
        ),
      ).rejects.toMatchObject({ code: '42501' })
    })

    it('blocks direct client writes to transfers', async () => {
      const quoteId = await seedQuote(USER_A)
      const { transfer } = await createTransfer(quoteId, USER_A)
      const upd = await asRole(
        'authenticated',
        USER_A,
        `update public.transfers set funding_cleared = true where id = $1`,
        [transfer.id],
      )
      expect(upd.rowCount).toBe(0)
    })
  })
})
