import { supabaseAdmin } from './supabase.js'
import { createExternalAccount, listExternalAccounts, BridgeApiError } from './bridge.js'
import { decryptString, DecryptionError } from '../utils/encryption.js'

// Deferred Bridge registration for payout destinations.
//
// Under KYC-at-first-send (K-lane) a sender adds recipients BEFORE any Bridge
// customer exists — verification happens in the pay step, not onboarding.
// Registration therefore cannot happen at destination-create time, and the
// old ordering deadlocked: creating a destination demanded a Bridge customer,
// the customer only appeared at first send, and first send needed a
// destination. Destinations are now persisted with a null
// `provider_account_ref` and registered here, the moment a customer exists.
//
// `checkPayability` still refuses to pay a destination without a ref — that
// backstop is unchanged and deliberate. This module exists so the ref
// actually arrives.

export interface DestinationRegistrationResult {
  registered: number
  failed: { destinationId: string; reason: string }[]
}

interface PendingRow {
  id: string
  recipient_id: string
  details: { clabe_ciphertext?: string; clabe_last4?: string }
  recipients: { first_name: string; last_name: string } | { first_name: string; last_name: string }[]
}

/**
 * Register one destination's CLABE with Bridge, tolerating the account
 * already existing there.
 *
 * Bridge dedupes identical CLABEs per customer (`duplicate_external_account`),
 * which a retry, a crashed backfill, or a re-added account all reach. Adopting
 * the existing account is the only correct answer — minting a second is
 * impossible and failing would strand the destination permanently. The match
 * must be unambiguous: Bridge exposes only `last_4`, so a collision is left
 * unregistered for a human rather than guessed at.
 */
async function registerOne(
  customerId: string,
  row: PendingRow,
): Promise<{ accountId: string } | { error: string }> {
  const recipient = Array.isArray(row.recipients) ? row.recipients[0] : row.recipients
  if (!recipient) return { error: 'recipient_missing' }
  if (!row.details.clabe_ciphertext) return { error: 'clabe_missing' }

  let clabe: string
  try {
    clabe = decryptString(row.details.clabe_ciphertext, row.recipient_id)
  } catch (err) {
    // A ciphertext we cannot read is a human problem, never a retry loop.
    return { error: err instanceof DecryptionError ? 'clabe_undecryptable' : 'clabe_decrypt_error' }
  }

  try {
    const account = await createExternalAccount(customerId, {
      firstName: recipient.first_name,
      lastName: recipient.last_name,
      clabe,
    })
    return { accountId: account.id }
  } catch (err) {
    if (!(err instanceof BridgeApiError)) return { error: 'bridge_unreachable' }
    const bridgeCode = (err.body as { code?: string } | null)?.code
    if (bridgeCode !== 'duplicate_external_account') {
      return { error: err.status < 500 ? `bridge_rejected_${err.status}` : 'bridge_unavailable' }
    }

    let accounts: Awaited<ReturnType<typeof listExternalAccounts>>
    try {
      accounts = await listExternalAccounts(customerId)
    } catch {
      return { error: 'bridge_list_failed' }
    }
    const matches = accounts.filter((a) => a.clabeLast4 === clabe.slice(-4))
    if (matches.length !== 1) return { error: 'duplicate_ambiguous' }
    return { accountId: matches[0]!.id }
  }
}

/**
 * Register every one of this user's active destinations that still lacks a
 * Bridge account, and persist the refs.
 *
 * Best-effort by contract: partial failure is reported, never thrown. Callers
 * are on paths where a Bridge hiccup must not break the user's flow (minting
 * a KYC link, submitting a payout) — an unregistered destination simply stays
 * unpayable, which `checkPayability` already handles by holding rather than
 * paying blind.
 */
export async function registerPendingDestinations(
  userId: string,
  bridgeCustomerId: string,
): Promise<DestinationRegistrationResult> {
  const { data, error } = await supabaseAdmin
    .from('payout_destinations')
    .select('id, recipient_id, details, recipients!inner(first_name, last_name, user_id, status)')
    .is('provider_account_ref', null)
    .eq('status', 'active')
    .eq('recipients.user_id', userId)
    .eq('recipients.status', 'active')
  if (error) throw new Error(`pending destinations select failed: ${error.message}`)

  const rows = (data ?? []) as unknown as PendingRow[]
  const result: DestinationRegistrationResult = { registered: 0, failed: [] }

  for (const row of rows) {
    const outcome = await registerOne(bridgeCustomerId, row)
    if ('error' in outcome) {
      result.failed.push({ destinationId: row.id, reason: outcome.error })
      continue
    }

    // Scoped to the still-null ref: if a concurrent caller (the KYC-link
    // backfill racing the payout worker) registered first, theirs stands and
    // this write is a no-op rather than an overwrite.
    const { error: saveError } = await supabaseAdmin
      .from('payout_destinations')
      .update({ provider_account_ref: outcome.accountId })
      .eq('id', row.id)
      .is('provider_account_ref', null)
    if (saveError) {
      result.failed.push({ destinationId: row.id, reason: 'persist_failed' })
      continue
    }
    result.registered++
  }

  return result
}
