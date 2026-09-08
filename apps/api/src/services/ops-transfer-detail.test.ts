import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// The per-transfer ops read (ops board slice 1). Harness: per-table chain
// mocks + frozen clock (ops-overview.test.ts style). The two things this
// suite exists to pin: (1) the column lists — the PII rule is enforced at the
// QUERY, so the select strings themselves are asserted; (2) the shape math
// (per-batch net, claim status, dwell, booleans) an operator reads as truth.

const from = vi.fn()
vi.mock('./supabase.js', () => ({
  supabaseAdmin: { from: (...args: unknown[]) => from(...args) },
}))

const envMock = vi.hoisted(() => ({
  STUCK_FUNDED_AFTER_MINUTES: 15,
  STUCK_SUBMITTED_AFTER_MINUTES: 30,
  STUCK_IN_FLIGHT_AFTER_MINUTES: 60,
  STUCK_UNDER_REVIEW_AFTER_HOURS: 24,
  MANUAL_PENDING_MAX_AGE_DAYS: 7,
  FLOAT_CEILING_MINOR: undefined as number | undefined,
  FUNDING_PROCESSOR: 'manual' as string,
}))
vi.mock('../config/env.js', () => ({ env: envMock }))

// ops-overview's other panel seams — imported for dwellFor, never called here.
vi.mock('./cancellation-review.js', () => ({ listPendingReviews: vi.fn() }))
vi.mock('./payouts.js', () => ({ isFloatCeilingTripped: vi.fn() }))
vi.mock('./ledger.js', () => ({ getAccountBalance: vi.fn() }))

// refunds.ts drags the Bridge client in; the two seams this service uses are
// mocked. classifyRefundClaim's window arithmetic is pinned in refunds.test.ts.
const recordedReturnEvent = vi.hoisted(() => vi.fn())
vi.mock('./refunds.js', () => ({
  recordedReturnEvent: (...args: unknown[]) => recordedReturnEvent(...args),
  classifyRefundClaim: (at: string | null) => (at == null ? 'unclaimed' : 'claimed'),
  listRefundBacklog: vi.fn(),
}))

const { buildOpsTransferDetail } = await import('./ops-transfer-detail.js')

const NOW = new Date('2026-09-08T12:00:00.000Z')
const nowMs = NOW.getTime()
const minutesAgo = (m: number) => new Date(nowMs - m * 60_000).toISOString()

const T = 'cccccccc-1111-4222-8333-444444444444'

type Result = { data: unknown; error: { message: string } | null }
let results: Record<string, Result>
let selects: Record<string, string[]>
let ors: string[]

function chain(table: string) {
  const c: Record<string, unknown> = {}
  for (const m of ['eq', 'in', 'order', 'limit']) c[m] = vi.fn().mockReturnValue(c)
  c['select'] = vi.fn((cols: string) => {
    ;(selects[table] ??= []).push(cols)
    return c
  })
  c['or'] = vi.fn((clause: string) => {
    ors.push(clause)
    return c
  })
  const resolve = () => results[table] ?? { data: null, error: { message: `no fixture for ${table}` } }
  c['maybeSingle'] = vi.fn(async () => resolve())
  c['then'] = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    Promise.resolve(resolve()).then(res, rej)
  return c
}

const transferRow = (over: Record<string, unknown> = {}) => ({
  id: T,
  state: 'FUNDED',
  send_amount_minor: 30_000,
  send_currency: 'USD',
  receive_amount_minor: 540_000,
  receive_currency: 'MXN',
  fee_amount_minor: 500,
  margin_minor: 0,
  fx_rate: 18,
  funding_source_type: 'ach',
  funding_processor: 'stripe_crypto',
  funding_cleared: false,
  funding_payment_ref: 'cos_1',
  provider_transfer_ref: null,
  refund_payment_ref: null,
  refunded_at: null,
  payout_hold_reason: 'velocity_review',
  payout_held_at: minutesAgo(30),
  submit_attempted_at: null,
  cancellation_requested_at: null,
  payment_claimed_at: null,
  disclosure_accepted_at: minutesAgo(100),
  payment_at: minutesAgo(90),
  cancelable_until: minutesAgo(60),
  completed_at: null,
  created_at: minutesAgo(105),
  refund_claimed_at: null,
  refund_claimed_by: null,
  quote_id: 'q-1',
  payout_destination_id: 'd-1',
  ...over,
})

beforeEach(() => {
  from.mockReset().mockImplementation((table: string) => chain(table))
  recordedReturnEvent.mockReset().mockResolvedValue(null)
  selects = {}
  ors = []
  results = {
    transfers: { data: transferRow(), error: null },
    quotes: {
      data: {
        fx_rate: 18,
        source_rate: 18.2,
        margin_minor: 0,
        fx_rate_at: minutesAgo(106),
        expires_at: minutesAgo(76),
        status: 'accepted',
        created_at: minutesAgo(106),
      },
      error: null,
    },
    payout_destinations: {
      data: { status: 'active', provider_account_ref: 'ea_1', recipients: { status: 'active' } },
      error: null,
    },
    transfer_transitions: {
      data: [
        { from_state: null, to_state: 'PENDING_PAYMENT', actor: 'user', reason: null, created_at: minutesAgo(105) },
        { from_state: 'PENDING_PAYMENT', to_state: 'FUNDED', actor: 'webhook:funding', reason: null, created_at: minutesAgo(90) },
      ],
      error: null,
    },
    ledger_transactions: {
      data: [
        {
          id: 'lt-1',
          transition: 'FUNDED',
          idempotency_key: `${T}:FUNDED`,
          description: 'funded',
          posted_at: minutesAgo(90),
          ledger_entries: [
            { direction: 'debit', amount_minor: 30_500, currency: 'USD', ledger_accounts: { code: 'funding_receivable' } },
            { direction: 'credit', amount_minor: 30_000, currency: 'USD', ledger_accounts: [{ code: 'transfer_payable' }] },
            { direction: 'credit', amount_minor: 500, currency: 'USD', ledger_accounts: { code: 'fee_revenue' } },
          ],
        },
      ],
      error: null,
    },
    payment_events: {
      data: [
        {
          id: 'ev-1',
          source: 'funding',
          event_type: 'funding_succeeded',
          status: 'processed',
          received_at: minutesAgo(90),
          processed_at: minutesAgo(89),
          provider_ref: 'cos_1',
          error: null,
        },
        {
          id: 'ev-2',
          source: 'funding',
          event_type: 'funding_failed',
          status: 'failed',
          received_at: minutesAgo(95),
          processed_at: null,
          provider_ref: 'cos_1',
          error: 'provider said: card declined for J. Doe',
        },
      ],
      error: null,
    },
    cancellation_requests: { data: [], error: null },
    deposit_instructions: { data: null, error: null },
    disclosures: {
      data: [{ type: 'prepayment', locale: 'es', presented_at: minutesAgo(104) }],
      error: null,
    },
  }
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('buildOpsTransferDetail', () => {
  it('returns null for an unknown transfer without reading anything else', async () => {
    results['transfers'] = { data: null, error: null }
    expect(await buildOpsTransferDetail(T)).toBeNull()
    expect(from).toHaveBeenCalledTimes(1)
    expect(from).toHaveBeenCalledWith('transfers')
  })

  it('throws (fails closed) when the transfer read errors', async () => {
    results['transfers'] = { data: null, error: { message: 'boom' } }
    await expect(buildOpsTransferDetail(T)).rejects.toThrow(/transfer select failed: boom/)
  })

  // The PII rule lives in the column lists. This is the test that fails the
  // day someone adds `user_id` or `bank_account_number` to a select.
  it('never selects a PII-bearing column on any table', async () => {
    await buildOpsTransferDetail(T)
    const allSelects = Object.entries(selects).flatMap(([table, cols]) => cols.map((c) => `${table}: ${c}`))
    expect(allSelects.length).toBeGreaterThanOrEqual(9)
    for (const forbidden of [
      'user_id',
      'bank_account_number',
      'bank_routing_number',
      'bank_beneficiary_name',
      'payload',
      'metadata',
      'first_name',
      'last_name',
      'phone',
      'email',
      'clabe',
      'details',
      'resolution,',
    ]) {
      for (const sel of allSelects) expect(sel).not.toContain(forbidden)
    }
    // The destination join asks the recipient for its STATUS and nothing else.
    expect(selects['payout_destinations']?.[0]).toBe('status, provider_account_ref, recipients!inner(status)')
  })

  it('maps the transfer, quote, and destination statuses — never the account ref value', async () => {
    const detail = await buildOpsTransferDetail(T)
    expect(detail?.transfer).toMatchObject({
      transferId: T,
      state: 'FUNDED',
      sendAmountMinor: 30_000,
      feeAmountMinor: 500,
      fundingProcessor: 'stripe_crypto',
      payoutHoldReason: 'velocity_review',
    })
    expect(detail?.quote).toMatchObject({ sourceRate: 18.2, status: 'accepted' })
    expect(detail?.destination).toEqual({
      status: 'active',
      hasProviderAccountRef: true,
      recipientStatus: 'active',
    })
    expect(JSON.stringify(detail)).not.toContain('ea_1')
  })

  it('falls back to the process rail for a pre-K6a null funding_processor', async () => {
    results['transfers'] = { data: transferRow({ funding_processor: null }), error: null }
    const detail = await buildOpsTransferDetail(T)
    expect(detail?.transfer.fundingProcessor).toBe('manual')
  })

  it('computes the dwell with the board clock for a watched state, and none for a terminal one', async () => {
    const funded = await buildOpsTransferDetail(T)
    // FUNDED anchors on payment_at (90 min ago) against the 15-min threshold.
    expect(funded?.transfer.dwell).toEqual({
      enteredStateAt: minutesAgo(90),
      dwellMinutes: 90,
      thresholdMinutes: 15,
      overThreshold: true,
    })

    results['transfers'] = { data: transferRow({ state: 'COMPLETED', completed_at: minutesAgo(1) }), error: null }
    const completed = await buildOpsTransferDetail(T)
    expect(completed?.transfer.dwell).toBeNull()
  })

  it('renders each ledger batch with its entries, account codes, and a per-batch net', async () => {
    const detail = await buildOpsTransferDetail(T)
    expect(detail?.ledger).toHaveLength(1)
    const batch = detail!.ledger[0]!
    expect(batch.idempotencyKey).toBe(`${T}:FUNDED`)
    expect(batch.netMinor).toBe(0)
    expect(batch.entries.map((e) => e.accountCode)).toEqual([
      'funding_receivable',
      'transfer_payable',
      'fee_revenue',
    ])
    expect(batch.entries[0]).toEqual({
      accountCode: 'funding_receivable',
      direction: 'debit',
      amountMinor: 30_500,
      currency: 'USD',
    })
  })

  it('surfaces an unbalanced batch as a non-zero net rather than hiding or throwing', async () => {
    results['ledger_transactions'] = {
      data: [
        {
          id: 'lt-x',
          transition: 'FUNDED',
          idempotency_key: `${T}:FUNDED`,
          description: null,
          posted_at: minutesAgo(90),
          ledger_entries: [
            { direction: 'debit', amount_minor: 100, currency: 'USD', ledger_accounts: { code: 'a' } },
            { direction: 'credit', amount_minor: 90, currency: 'USD', ledger_accounts: { code: 'b' } },
          ],
        },
      ],
      error: null,
    }
    const detail = await buildOpsTransferDetail(T)
    expect(detail?.ledger[0]?.netMinor).toBe(10)
  })

  it('reports the refund tail keys by presence', async () => {
    results['transfers'] = {
      data: transferRow({ state: 'REFUNDED', provider_transfer_ref: 'br_1', refund_payment_ref: 're_1' }),
      error: null,
    }
    results['ledger_transactions'] = {
      data: [
        { id: '1', transition: 'bridge_return', idempotency_key: `${T}:bridge_return`, description: null, posted_at: minutesAgo(5), ledger_entries: [] },
        { id: '2', transition: 'REFUNDED', idempotency_key: `${T}:REFUNDED`, description: null, posted_at: minutesAgo(4), ledger_entries: [] },
      ],
      error: null,
    }
    const detail = await buildOpsTransferDetail(T)
    expect(detail?.refund.ledgerKeys).toEqual({ bridgeReturn: true, refunded: true })
  })

  it('reads the recorded return event through refunds.ts, never calling Bridge', async () => {
    results['transfers'] = { data: transferRow({ provider_transfer_ref: 'br_1' }), error: null }
    recordedReturnEvent.mockResolvedValue('returned')
    const detail = await buildOpsTransferDetail(T)
    expect(recordedReturnEvent).toHaveBeenCalledWith(T, 'br_1')
    expect(detail?.refund.returnEventType).toBe('returned')
  })

  it('classifies the refund claim from the row it already holds', async () => {
    results['transfers'] = {
      data: transferRow({ refund_claimed_at: minutesAgo(2), refund_claimed_by: 'ops:x' }),
      error: null,
    }
    const detail = await buildOpsTransferDetail(T)
    expect(detail?.refund).toMatchObject({ claimStatus: 'claimed', claimedAt: minutesAgo(2), claimedBy: 'ops:x' })
  })

  it('reduces payment_events error text to a boolean and keeps events newest-first as read', async () => {
    const detail = await buildOpsTransferDetail(T)
    expect(detail?.paymentEvents.map((e) => [e.id, e.hasError])).toEqual([
      ['ev-1', false],
      ['ev-2', true],
    ])
    expect(JSON.stringify(detail)).not.toContain('J. Doe')
  })

  it('matches payment events on the transfer id, adding the provider ref when present', async () => {
    await buildOpsTransferDetail(T)
    expect(ors).toEqual([`transfer_id.eq.${T}`])

    ors = []
    results['transfers'] = { data: transferRow({ provider_transfer_ref: 'br_ok-1' }), error: null }
    await buildOpsTransferDetail(T)
    expect(ors).toEqual([`transfer_id.eq.${T},provider_ref.eq.br_ok-1`])
  })

  // Unlike refunds.ts findReturnEvent (where dropping a bad ref only tightens a
  // verdict), a display read must not silently narrow — it throws.
  it('refuses a malformed provider ref rather than silently dropping it from the predicate', async () => {
    results['transfers'] = { data: transferRow({ provider_transfer_ref: 'x),or(1.eq.1' }), error: null }
    await expect(buildOpsTransferDetail(T)).rejects.toThrow(/malformed provider ref/)
    expect(ors).toEqual([])
  })

  it('bounds transition reasons — the one provider-sourced string on the wire', async () => {
    results['transfer_transitions'] = {
      data: [
        { from_state: 'PENDING_PAYMENT', to_state: 'PAYMENT_FAILED', actor: 'webhook:funding', reason: 'x'.repeat(500), created_at: minutesAgo(1) },
      ],
      error: null,
    }
    const detail = await buildOpsTransferDetail(T)
    expect(detail?.transitions[0]?.reason).toHaveLength(200)
  })

  it('refuses a malformed transfer id before it can reach the or() filter string', async () => {
    results['transfers'] = { data: transferRow({ id: 'x),or(1.eq.1' }), error: null }
    await expect(buildOpsTransferDetail('x),or(1.eq.1')).rejects.toThrow(/malformed transfer id/)
    expect(ors).toEqual([])
  })

  it('maps deposit instructions to the operator handle only — no bank coordinates', async () => {
    results['deposit_instructions'] = {
      data: {
        bridge_transfer_ref: 'onramp-1',
        currency: 'USD',
        amount_minor: 30_500,
        payment_rail: 'ach',
        deposit_message: 'PUENTE-ABC',
        attached_by: null,
      },
      error: null,
    }
    const detail = await buildOpsTransferDetail(T)
    expect(detail?.depositInstructions).toEqual({
      bridgeTransferRef: 'onramp-1',
      currency: 'USD',
      amountMinor: 30_500,
      paymentRail: 'ach',
      depositMessage: 'PUENTE-ABC',
      attachedBy: null,
    })
  })

  it('maps disclosures and cancellation requests', async () => {
    results['cancellation_requests'] = {
      data: [
        {
          id: 'cr-1',
          requested_at: minutesAgo(20),
          requested_state: 'SUBMITTED',
          within_window: true,
          status: 'pending',
          resolved_at: null,
          resolved_by: null,
        },
      ],
      error: null,
    }
    const detail = await buildOpsTransferDetail(T)
    expect(detail?.disclosures).toEqual([{ type: 'prepayment', locale: 'es', presentedAt: minutesAgo(104) }])
    expect(detail?.cancellationRequests).toEqual([
      {
        id: 'cr-1',
        requestedAt: minutesAgo(20),
        requestedState: 'SUBMITTED',
        withinWindow: true,
        status: 'pending',
        resolvedAt: null,
        resolvedBy: null,
      },
    ])
  })

  // transfers.quote_id and transfers.payout_destination_id are NOT NULL FKs, so
  // a missing row on either join is a broken read, not an absent panel — the
  // service must fail closed rather than render "no quote on file".
  it('fails closed when the quote or destination join returns no row', async () => {
    results['quotes'] = { data: null, error: null }
    await expect(buildOpsTransferDetail(T)).rejects.toThrow(/quote select failed: no row/)

    results['quotes'] = {
      data: { fx_rate: 18, source_rate: 18.2, margin_minor: 0, fx_rate_at: minutesAgo(1), expires_at: minutesAgo(1), status: 'accepted', created_at: minutesAgo(1) },
      error: null,
    }
    results['payout_destinations'] = { data: null, error: null }
    await expect(buildOpsTransferDetail(T)).rejects.toThrow(/destination select failed: no row/)
  })

  it('treats missing deposit instructions as genuinely absent (the one optional join)', async () => {
    results['deposit_instructions'] = { data: null, error: null }
    const detail = await buildOpsTransferDetail(T)
    expect(detail?.depositInstructions).toBeNull()
  })

  it('throws loudly when a list read hits the PostgREST row cap', async () => {
    results['transfer_transitions'] = {
      data: Array.from({ length: 1000 }, (_, i) => ({
        from_state: null,
        to_state: 'FUNDED',
        actor: 'system',
        reason: null,
        created_at: minutesAgo(i),
      })),
      error: null,
    }
    await expect(buildOpsTransferDetail(T)).rejects.toThrow(/transitions hit the 1000-row PostgREST cap/)
  })

  it('throws (fails closed) when a list read errors', async () => {
    results['payment_events'] = { data: null, error: { message: 'db down' } }
    await expect(buildOpsTransferDetail(T)).rejects.toThrow(/payment-events select failed: db down/)
  })
})
