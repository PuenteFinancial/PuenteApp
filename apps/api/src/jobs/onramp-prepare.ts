import * as Sentry from '@sentry/node'
import { env } from '../config/env.js'
import { supabaseAdmin } from '../services/supabase.js'
import { createBridgeOnramp, BridgeApiError } from '../services/bridge.js'
import { attachDepositInstructions } from '../services/deposit-instructions.js'
import { minorToDecimal } from '../services/payouts.js'

// The `funding.onramp_prepare` job (funding-ops slice 3) — enqueued by the
// confirm route after funding_payment_ref persists. Creates the Bridge onramp
// (the sender's deposit target) and attaches its coordinates to the transfer
// with system attribution, so the pay step renders them with zero operator
// action. Everything here is an idempotent replay: the existing-instructions
// check retires duplicates, the Bridge POST is keyed `onramp-<transferId>`,
// and attach upserts on transfer_id.
//
// Failure posture: a throw = pg-boss retry (Bridge downtime, coordinates not
// issued yet). Deterministic dead ends — no Bridge customer, an idempotency
// conflict with a hand-created onramp, an amount mismatch — retire the job
// with a per-transfer Sentry page instead: retrying cannot change them, and
// the slice-1 attach button is the recovery path the page points at.

interface PrepareTransferRow {
  id: string
  user_id: string
  state: string
  send_amount_minor: number
  fee_amount_minor: number
  funding_payment_ref: string | null
}

const page = (fingerprint: string, transferId: string, message: string, context: Record<string, unknown>) => {
  Sentry.withScope((scope) => {
    scope.setFingerprint([fingerprint, transferId])
    scope.setContext('onramp_prepare', { transferId, ...context })
    Sentry.captureMessage(message, 'error')
  })
}

// Returns 1 when instructions were attached this run, 0 otherwise.
export async function prepareOnramp(transferId: string): Promise<number> {
  // Replay after a processor flip must not create Bridge objects for a rail
  // that no longer renders deposit instructions.
  if (env.FUNDING_PROCESSOR !== 'manual') return 0

  const { data: transferData, error: transferError } = await supabaseAdmin
    .from('transfers')
    .select('id, user_id, state, send_amount_minor, fee_amount_minor, funding_payment_ref')
    .eq('id', transferId)
    .maybeSingle()
  if (transferError) throw new Error(`onramp-prepare load failed: ${transferError.message}`)
  const transfer = transferData as PrepareTransferRow | null

  // Gone, moved past PENDING_PAYMENT, or unconfirmed (ref unwound): the
  // instructions would never render — nothing to prepare.
  if (!transfer || transfer.state !== 'PENDING_PAYMENT') return 0
  if (!transfer.funding_payment_ref) return 0

  // Already attached — by a prior run or an operator (whose coordinates may be
  // a deliberate re-attach and must not be overwritten by a stale replay).
  const { data: existing, error: existingError } = await supabaseAdmin
    .from('deposit_instructions')
    .select('transfer_id')
    .eq('transfer_id', transfer.id)
    .maybeSingle()
  if (existingError) throw new Error(`onramp-prepare instructions read failed: ${existingError.message}`)
  if (existing) return 0

  const { data: userData, error: userError } = await supabaseAdmin
    .from('users')
    .select('bridge_customer_id')
    .eq('id', transfer.user_id)
    .maybeSingle()
  if (userError) throw new Error(`onramp-prepare user load failed: ${userError.message}`)
  const bridgeCustomerId =
    (userData as { bridge_customer_id: string | null } | null)?.bridge_customer_id ?? null
  if (!bridgeCustomerId) {
    // A confirmed sender without a Bridge customer is a data anomaly (approval
    // requires Bridge KYC) — no retry can mint one.
    page(
      'onramp-prepare-no-customer',
      transfer.id,
      'onramp prepare: sender has no bridge_customer_id — attach instructions by hand',
      { runbook: 'docs/runbooks/manual-funding-run.md' },
    )
    return 0
  }

  if (!env.BRIDGE_TREASURY_WALLET_ID) {
    // Unreachable under the manual superRefine; throw (config error) so the
    // job retries until the environment is fixed rather than retiring.
    throw new Error('onramp-prepare: BRIDGE_TREASURY_WALLET_ID is not set')
  }

  let onrampId: string
  try {
    const onramp = await createBridgeOnramp({
      transferId: transfer.id,
      onBehalfOf: bridgeCustomerId,
      treasuryWalletId: env.BRIDGE_TREASURY_WALLET_ID,
      // Cent-exact by construction — the attach-time mismatch check becomes a
      // tautology for auto-created onramps.
      amountUsd: minorToDecimal(transfer.send_amount_minor + transfer.fee_amount_minor),
    })
    onrampId = onramp.bridgeTransferId
  } catch (err) {
    if (err instanceof BridgeApiError && err.statusCode === 422) {
      // Same Idempotency-Key, different body — an operator already curl-created
      // this transfer's onramp with another serialization. Deterministic; the
      // attach button (with that onramp's id) is the fix.
      page(
        'onramp-prepare-conflict',
        transfer.id,
        'onramp prepare: idempotency conflict with a hand-created onramp — attach by hand',
        { runbook: 'docs/runbooks/manual-funding-run.md' },
      )
      return 0
    }
    // Bridge down / 5xx / timeout — pg-boss retries.
    throw err
  }

  const outcome = await attachDepositInstructions({
    transferId: transfer.id,
    bridgeTransferId: onrampId,
    operator: null, // system attribution — no human vouched for these
  })

  switch (outcome.outcome) {
    case 'attached':
      return 1
    // The transfer moved (or vanished) between the load and the attach —
    // instructions would never render.
    case 'unknown_transfer':
    case 'not_pending_payment':
      return 0
    // Bridge accepted the onramp but has not issued coordinates yet (or the
    // read failed transiently) — retry until they exist.
    case 'instructions_unavailable':
      throw new Error(`onramp-prepare: instructions unavailable yet for ${onrampId}`)
    case 'amount_mismatch':
      // Should be impossible for an auto-created onramp (amount comes from the
      // same frozen terms attach verifies against) — a mismatch means the id
      // under our key belongs to something else. Deterministic; break-glass.
      page(
        'onramp-prepare-amount-mismatch',
        transfer.id,
        'onramp prepare: Bridge onramp amount does not match the transfer — attach by hand',
        {
          expectedMinor: outcome.expectedMinor,
          bridgeMinor: outcome.bridgeMinor,
          runbook: 'docs/runbooks/manual-funding-run.md',
        },
      )
      return 0
  }
}
