import type { Money } from '@puente/shared'
import { moneyFromMinorUnits } from '@puente/shared'
import { supabaseAdmin } from './supabase.js'

// Double-entry ledger posting service. The only write path into
// ledger_transactions / ledger_entries — inserts happen atomically inside the
// post_ledger_transaction Postgres function (supabase-js has no transactions),
// and the database independently enforces net-zero, append-only, and
// amount > 0 (see the create_ledger migration). Validation here is the first
// line of defense; the DB triggers are the backstop.
//
// Amounts are integer minor units in a JS number: exact up to 2^53 - 1 minor
// units (~$90 trillion) — beyond MVP horizons, revisit with bigint if that
// ever changes.

export type LedgerDirection = 'debit' | 'credit'

export interface LedgerEntryInput {
  accountCode: string
  direction: LedgerDirection
  money: Money
}

export interface PostLedgerTransactionInput {
  /** Set for transfer-driven postings; null/absent for batch events (e.g. wallet replenishment). */
  transferId?: string | null
  /** The state transition that triggered the posting (e.g. 'FUNDED'). */
  transition?: string | null
  /**
   * Explicit idempotency key. Optional when transferId + transition are both
   * present (derived as `{transferId}:{transition}`); required otherwise.
   */
  idempotencyKey?: string
  description: string
  entries: LedgerEntryInput[]
}

export interface LedgerTransactionRecord {
  id: string
  transferId: string | null
  transition: string | null
  idempotencyKey: string
  description: string
  postedAt: string
}

export class LedgerValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LedgerValidationError'
  }
}

const DIRECTIONS: readonly LedgerDirection[] = ['debit', 'credit']

function resolveIdempotencyKey(input: PostLedgerTransactionInput): string {
  if (input.idempotencyKey) return input.idempotencyKey
  if (input.transferId && input.transition) return `${input.transferId}:${input.transition}`
  throw new LedgerValidationError(
    'an idempotency key is required: provide idempotencyKey, or both transferId and transition',
  )
}

function validateEntries(entries: LedgerEntryInput[]): void {
  if (entries.length < 2) {
    throw new LedgerValidationError(
      `a ledger transaction needs at least 2 entries, got ${entries.length}`,
    )
  }
  const netByCurrency = new Map<string, number>()
  for (const entry of entries) {
    if (!DIRECTIONS.includes(entry.direction)) {
      throw new LedgerValidationError(`invalid direction: ${String(entry.direction)}`)
    }
    const { amountMinor, currency } = entry.money
    if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
      throw new LedgerValidationError(
        `entry amounts must be positive integers (minor units), got ${amountMinor} for ${entry.accountCode}`,
      )
    }
    const signed = entry.direction === 'debit' ? amountMinor : -amountMinor
    netByCurrency.set(currency, (netByCurrency.get(currency) ?? 0) + signed)
  }
  for (const [currency, net] of netByCurrency) {
    if (net !== 0) {
      throw new LedgerValidationError(
        `entries do not net to zero for ${currency}: debits minus credits = ${net} minor units`,
      )
    }
  }
}

interface LedgerTransactionRow {
  id: string
  transfer_id: string | null
  transition: string | null
  idempotency_key: string
  description: string
  posted_at: string
}

export async function postLedgerTransaction(
  input: PostLedgerTransactionInput,
): Promise<LedgerTransactionRecord> {
  const description = input.description.trim()
  if (!description) {
    throw new LedgerValidationError('description is required')
  }
  const idempotencyKey = resolveIdempotencyKey(input)
  validateEntries(input.entries)

  const { data, error } = await supabaseAdmin.rpc('post_ledger_transaction', {
    p_idempotency_key: idempotencyKey,
    p_description: description,
    p_transfer_id: input.transferId ?? null,
    p_transition: input.transition ?? null,
    p_entries: input.entries.map((entry) => ({
      account_code: entry.accountCode,
      direction: entry.direction,
      amount_minor: entry.money.amountMinor,
      currency: entry.money.currency,
    })),
  })
  if (error) {
    throw new Error(`ledger post failed: ${error.message}`)
  }
  const row = (Array.isArray(data) ? data[0] : data) as LedgerTransactionRow | undefined
  if (!row) {
    throw new Error('ledger post failed: no transaction row returned')
  }
  return {
    id: row.id,
    transferId: row.transfer_id,
    transition: row.transition,
    idempotencyKey: row.idempotency_key,
    description: row.description,
    postedAt: row.posted_at,
  }
}

interface LedgerBalanceRow {
  amount_minor: number
  currency: string
}

/**
 * Derived balance of one account: SUM over its entries, signed by the
 * account's normal balance (never stored). Slice 8's float ceiling reads this.
 */
export async function getAccountBalance(accountCode: string): Promise<Money> {
  const { data, error } = await supabaseAdmin.rpc('ledger_account_balance', {
    p_account_code: accountCode,
  })
  if (error) {
    throw new Error(`ledger balance failed: ${error.message}`)
  }
  const row = (Array.isArray(data) ? data[0] : data) as LedgerBalanceRow | undefined
  if (!row) {
    throw new Error(`ledger balance failed: no row returned for ${accountCode}`)
  }
  return moneyFromMinorUnits(Number(row.amount_minor), row.currency.trim())
}
