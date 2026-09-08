import { supabaseAdmin } from './supabase.js'
import { processorNameFor } from './funding/index.js'
import { dwellFor, type OpsDwell } from './ops-overview.js'
import { classifyRefundClaim, recordedReturnEvent, type ClaimStatus } from './refunds.js'

// One transfer, the whole story (ops board slice 1, GET /v1/ops/transfers/:id,
// docs/api-contract.md). Everything an operator used to assemble from the
// terminal plus the Supabase and Bridge dashboards, in one read.
//
// PII discipline — the same rule as the overview, enforced at the QUERY (the
// route's response schema enforces it again on the wire): ids, amounts,
// timestamps, states, transition actors, opaque provider refs, and the
// STATUSES of joined rows. Never names, never user ids, never the destination
// (no CLABE in any form), never bank coordinates, never raw provider payloads,
// never transfer_transitions.metadata. Every column list below is a single
// string literal; a column that is not in it cannot leak.
//
// Every list read is bounded and fails CLOSED (ops-overview posture): a broken
// read 500s the route — an empty timeline and a broken read must never look
// the same. The quote and destination joins fail closed too: both FKs are NOT
// NULL on transfers, so a missing row there is a broken read, never an absent
// panel (only deposit_instructions is genuinely optional). No provider is ever
// called from this path: a page load must not block on Bridge; the live half of
// the refund interlock runs in the action.
//
// One admitted exception to "never provider text": transfer_transitions.reason.
// Most writers use a literal, but two carry a short provider string verbatim
// (a Stripe last_error on the reaper path, a decline/failure code on the
// funding webhook). It is the operator's diagnostic and rides this admin-only
// wire deliberately, length-bounded; nothing else provider-authored does.

const ROW_BOUND = 1000

// Same guard as refunds.ts findReturnEvent: the id is interpolated into a
// PostgREST `or` filter STRING for the payment_events read, so its shape is
// checked here even though the route's params schema already pins it.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface OpsTransferDetail {
  generatedAt: string
  transfer: {
    transferId: string
    state: string
    sendAmountMinor: number
    sendCurrency: string
    receiveAmountMinor: number
    receiveCurrency: string
    feeAmountMinor: number
    marginMinor: number
    fxRate: number
    fundingSourceType: string
    fundingProcessor: string
    fundingCleared: boolean
    fundingPaymentRef: string | null
    providerTransferRef: string | null
    refundPaymentRef: string | null
    payoutHoldReason: string | null
    payoutHeldAt: string | null
    submitAttemptedAt: string | null
    cancellationRequestedAt: string | null
    paymentClaimedAt: string | null
    disclosureAcceptedAt: string | null
    paymentAt: string | null
    cancelableUntil: string | null
    completedAt: string | null
    refundedAt: string | null
    createdAt: string
    dwell: OpsDwell | null
  }
  quote: {
    fxRate: number
    sourceRate: number
    marginMinor: number
    fxRateAt: string
    expiresAt: string
    createdAt: string
    status: string
  } | null
  destination: {
    status: string
    hasProviderAccountRef: boolean
    recipientStatus: string | null
  } | null
  refund: {
    claimStatus: ClaimStatus
    claimedAt: string | null
    claimedBy: string | null
    returnEventType: string | null
    ledgerKeys: { bridgeReturn: boolean; refunded: boolean }
  }
  transitions: Array<{
    fromState: string | null
    toState: string
    actor: string
    reason: string | null
    createdAt: string
  }>
  ledger: Array<{
    transition: string | null
    idempotencyKey: string
    description: string | null
    postedAt: string
    netMinor: number
    entries: Array<{ accountCode: string; direction: string; amountMinor: number; currency: string }>
  }>
  paymentEvents: Array<{
    id: string
    source: string
    eventType: string
    status: string
    receivedAt: string
    processedAt: string | null
    providerRef: string | null
    hasError: boolean
  }>
  cancellationRequests: Array<{
    id: string
    requestedAt: string
    requestedState: string
    withinWindow: boolean
    status: string
    resolvedAt: string | null
    resolvedBy: string | null
  }>
  depositInstructions: {
    bridgeTransferRef: string
    currency: string
    amountMinor: number
    paymentRail: string
    depositMessage: string
    attachedBy: string | null
  } | null
  disclosures: Array<{ type: string; locale: string; presentedAt: string }>
}

// One string literal each (supabase-js parses the column list at the type
// level; concatenation collapses the row type). quote_id and
// payout_destination_id are selected to drive the joins and never emitted.
const TRANSFER_COLUMNS =
  'id, state, send_amount_minor, send_currency, receive_amount_minor, receive_currency, fee_amount_minor, margin_minor, fx_rate, funding_source_type, funding_processor, funding_cleared, funding_payment_ref, provider_transfer_ref, refund_payment_ref, refunded_at, payout_hold_reason, payout_held_at, submit_attempted_at, cancellation_requested_at, payment_claimed_at, disclosure_accepted_at, payment_at, cancelable_until, completed_at, created_at, refund_claimed_at, refund_claimed_by, quote_id, payout_destination_id'
const QUOTE_COLUMNS = 'fx_rate, source_rate, margin_minor, fx_rate_at, expires_at, status, created_at'
const DESTINATION_COLUMNS = 'status, provider_account_ref, recipients!inner(status)'
const TRANSITION_COLUMNS = 'from_state, to_state, actor, reason, created_at'
const LEDGER_COLUMNS =
  'id, transition, idempotency_key, description, posted_at, ledger_entries(direction, amount_minor, currency, ledger_accounts(code))'
const EVENT_COLUMNS = 'id, source, event_type, status, received_at, processed_at, provider_ref, error'
const CANCELLATION_COLUMNS =
  'id, requested_at, requested_state, within_window, status, resolved_at, resolved_by'
// Puente's own receiving coordinates live on this row too (bank_* columns);
// they are sender-facing and stay off the ops wire — the onramp ref is the
// operator's handle.
const DEPOSIT_COLUMNS =
  'bridge_transfer_ref, currency, amount_minor, payment_rail, deposit_message, attached_by'
const DISCLOSURE_COLUMNS = 'type, locale, presented_at'

interface TransferRow {
  id: string
  state: string
  send_amount_minor: number
  send_currency: string
  receive_amount_minor: number
  receive_currency: string
  fee_amount_minor: number
  margin_minor: number
  fx_rate: number
  funding_source_type: string
  funding_processor: string | null
  funding_cleared: boolean
  funding_payment_ref: string | null
  provider_transfer_ref: string | null
  refund_payment_ref: string | null
  refunded_at: string | null
  payout_hold_reason: string | null
  payout_held_at: string | null
  submit_attempted_at: string | null
  cancellation_requested_at: string | null
  payment_claimed_at: string | null
  disclosure_accepted_at: string | null
  payment_at: string | null
  cancelable_until: string | null
  completed_at: string | null
  created_at: string
  refund_claimed_at: string | null
  refund_claimed_by: string | null
  quote_id: string
  payout_destination_id: string
}

interface QuoteRow {
  fx_rate: number
  source_rate: number
  margin_minor: number
  fx_rate_at: string
  expires_at: string
  status: string
  created_at: string
}

// PostgREST returns a to-one embed as an object, a to-many as an array;
// supabase-js types it loosely, so both shapes are handled (payouts.ts
// checkPayability precedent).
interface DestinationRow {
  status: string
  provider_account_ref: string | null
  recipients: { status: string } | Array<{ status: string }> | null
}

interface TransitionRow {
  from_state: string | null
  to_state: string
  actor: string
  reason: string | null
  created_at: string
}

interface LedgerEntryRow {
  direction: string
  amount_minor: number
  currency: string
  ledger_accounts: { code: string } | Array<{ code: string }> | null
}

interface LedgerTransactionRow {
  id: string
  transition: string | null
  idempotency_key: string
  description: string | null
  posted_at: string
  ledger_entries: LedgerEntryRow[] | null
}

interface EventRow {
  id: string
  source: string
  event_type: string
  status: string
  received_at: string
  processed_at: string | null
  provider_ref: string | null
  error: string | null
}

interface CancellationRow {
  id: string
  requested_at: string
  requested_state: string
  within_window: boolean
  status: string
  resolved_at: string | null
  resolved_by: string | null
}

interface DepositRow {
  bridge_transfer_ref: string
  currency: string
  amount_minor: number
  payment_rail: string
  deposit_message: string
  attached_by: string | null
}

interface DisclosureRow {
  type: string
  locale: string
  presented_at: string
}

type ReadResult = { data: unknown; error: { message: string } | null }

async function readList<T>(label: string, query: PromiseLike<ReadResult>): Promise<T[]> {
  const { data, error } = await query
  if (error || data == null) {
    throw new Error(`ops transfer-detail ${label} select failed: ${error?.message ?? 'no rows returned'}`)
  }
  const rows = data as T[]
  if (rows.length >= ROW_BOUND) {
    throw new Error(
      `ops transfer-detail ${label} hit the ${ROW_BOUND}-row PostgREST cap — results may be silently truncated`,
    )
  }
  return rows
}

async function readOne<T>(label: string, query: PromiseLike<ReadResult>): Promise<T | null> {
  const { data, error } = await query
  if (error) throw new Error(`ops transfer-detail ${label} select failed: ${error.message}`)
  return (data as T | null) ?? null
}

function firstOf<T>(value: T | T[] | null | undefined): T | null {
  if (value == null) return null
  return Array.isArray(value) ? (value[0] ?? null) : value
}

async function readTransfer(transferId: string): Promise<TransferRow | null> {
  return readOne<TransferRow>(
    'transfer',
    supabaseAdmin.from('transfers').select(TRANSFER_COLUMNS).eq('id', transferId).maybeSingle(),
  )
}

async function readQuote(quoteId: string): Promise<OpsTransferDetail['quote']> {
  const row = await readOne<QuoteRow>(
    'quote',
    supabaseAdmin.from('quotes').select(QUOTE_COLUMNS).eq('id', quoteId).maybeSingle(),
  )
  // transfers.quote_id is NOT NULL + FK: no row means the read is broken.
  if (row == null) throw new Error('ops transfer-detail quote select failed: no row for a required join')
  return {
    fxRate: row.fx_rate,
    sourceRate: row.source_rate,
    marginMinor: row.margin_minor,
    fxRateAt: row.fx_rate_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    status: row.status,
  }
}

async function readDestination(destinationId: string): Promise<OpsTransferDetail['destination']> {
  const row = await readOne<DestinationRow>(
    'destination',
    supabaseAdmin
      .from('payout_destinations')
      .select(DESTINATION_COLUMNS)
      .eq('id', destinationId)
      .maybeSingle(),
  )
  // transfers.payout_destination_id is NOT NULL + FK: same rule as the quote.
  if (row == null) {
    throw new Error('ops transfer-detail destination select failed: no row for a required join')
  }
  return {
    status: row.status,
    // The ref's PRESENCE is what payability needs; the value is an opaque
    // Bridge id the operator reads in the Bridge dashboard, not here.
    hasProviderAccountRef: row.provider_account_ref != null,
    recipientStatus: firstOf(row.recipients)?.status ?? null,
  }
}

async function readTransitions(transferId: string): Promise<OpsTransferDetail['transitions']> {
  const rows = await readList<TransitionRow>(
    'transitions',
    supabaseAdmin
      .from('transfer_transitions')
      .select(TRANSITION_COLUMNS)
      .eq('transfer_id', transferId)
      .order('created_at', { ascending: true })
      .limit(ROW_BOUND),
  )
  return rows.map((row) => ({
    fromState: row.from_state,
    toState: row.to_state,
    actor: row.actor,
    // Provider-sourced on two write paths (see header) — bounded here.
    reason: row.reason == null ? null : row.reason.slice(0, REASON_MAX_CHARS),
    createdAt: row.created_at,
  }))
}

const REASON_MAX_CHARS = 200

async function readLedger(transferId: string): Promise<OpsTransferDetail['ledger']> {
  const rows = await readList<LedgerTransactionRow>(
    'ledger',
    supabaseAdmin
      .from('ledger_transactions')
      .select(LEDGER_COLUMNS)
      .eq('transfer_id', transferId)
      .order('posted_at', { ascending: true })
      .limit(ROW_BOUND),
  )
  return rows.map((row) => {
    const entries = (row.ledger_entries ?? []).map((entry) => ({
      accountCode: firstOf(entry.ledger_accounts)?.code ?? 'unknown',
      direction: entry.direction,
      amountMinor: entry.amount_minor,
      currency: entry.currency,
    }))
    // The runbook's balance check (manual-refund.md "verify"): debits minus
    // credits per batch must be zero. Rendered, not asserted — the ledger
    // trigger already refuses an unbalanced commit; a non-zero here means the
    // read is wrong, which the operator must see, not a 500.
    const netMinor = entries.reduce(
      (sum, e) => sum + (e.direction === 'debit' ? e.amountMinor : -e.amountMinor),
      0,
    )
    return {
      transition: row.transition,
      idempotencyKey: row.idempotency_key,
      description: row.description,
      postedAt: row.posted_at,
      netMinor,
      entries,
    }
  })
}

async function readPaymentEvents(
  transferId: string,
  providerTransferRef: string | null,
): Promise<OpsTransferDetail['paymentEvents']> {
  // Ingest does not always resolve transfer_id (see payment-events.ts), so
  // match on either key — the refunds.ts findReturnEvent predicate. Both
  // interpolated values are charset-checked: the `or` filter is a STRING.
  // Unlike findReturnEvent, a malformed ref THROWS rather than being dropped:
  // there narrowing only makes a verdict stricter; here it would silently hide
  // the very events the second clause exists to find (security review).
  if (!UUID_RE.test(transferId)) {
    throw new Error('ops transfer-detail payment-events select failed: malformed transfer id')
  }
  const clauses = [`transfer_id.eq.${transferId}`]
  if (providerTransferRef != null) {
    if (!/^[A-Za-z0-9_-]+$/.test(providerTransferRef)) {
      throw new Error('ops transfer-detail payment-events select failed: malformed provider ref')
    }
    clauses.push(`provider_ref.eq.${providerTransferRef}`)
  }
  const rows = await readList<EventRow>(
    'payment-events',
    supabaseAdmin
      .from('payment_events')
      .select(EVENT_COLUMNS)
      .or(clauses.join(','))
      .order('received_at', { ascending: false })
      .limit(ROW_BOUND),
  )
  return rows.map((row) => ({
    id: row.id,
    source: row.source,
    eventType: row.event_type,
    status: row.status,
    receivedAt: row.received_at,
    processedAt: row.processed_at,
    providerRef: row.provider_ref,
    // The error text can echo provider bodies; the wire carries only whether
    // one was recorded. Sentry has the text.
    hasError: row.error != null,
  }))
}

async function readCancellationRequests(
  transferId: string,
): Promise<OpsTransferDetail['cancellationRequests']> {
  const rows = await readList<CancellationRow>(
    'cancellation-requests',
    supabaseAdmin
      .from('cancellation_requests')
      .select(CANCELLATION_COLUMNS)
      .eq('transfer_id', transferId)
      .order('requested_at', { ascending: true })
      .limit(ROW_BOUND),
  )
  return rows.map((row) => ({
    id: row.id,
    requestedAt: row.requested_at,
    requestedState: row.requested_state,
    withinWindow: row.within_window,
    status: row.status,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
  }))
}

async function readDepositInstructions(
  transferId: string,
): Promise<OpsTransferDetail['depositInstructions']> {
  const row = await readOne<DepositRow>(
    'deposit-instructions',
    supabaseAdmin
      .from('deposit_instructions')
      .select(DEPOSIT_COLUMNS)
      .eq('transfer_id', transferId)
      .maybeSingle(),
  )
  if (row == null) return null
  return {
    bridgeTransferRef: row.bridge_transfer_ref,
    currency: row.currency,
    amountMinor: row.amount_minor,
    paymentRail: row.payment_rail,
    depositMessage: row.deposit_message,
    attachedBy: row.attached_by,
  }
}

async function readDisclosures(transferId: string): Promise<OpsTransferDetail['disclosures']> {
  const rows = await readList<DisclosureRow>(
    'disclosures',
    supabaseAdmin
      .from('disclosures')
      .select(DISCLOSURE_COLUMNS)
      .eq('transfer_id', transferId)
      .order('presented_at', { ascending: true })
      .limit(ROW_BOUND),
  )
  return rows.map((row) => ({ type: row.type, locale: row.locale, presentedAt: row.presented_at }))
}

export async function buildOpsTransferDetail(transferId: string): Promise<OpsTransferDetail | null> {
  const nowMs = Date.now()
  const transfer = await readTransfer(transferId)
  if (transfer == null) return null

  const [
    quote,
    destination,
    transitions,
    ledger,
    paymentEvents,
    cancellationRequests,
    depositInstructions,
    disclosures,
    returnEventType,
  ] = await Promise.all([
    readQuote(transfer.quote_id),
    readDestination(transfer.payout_destination_id),
    readTransitions(transfer.id),
    readLedger(transfer.id),
    readPaymentEvents(transfer.id, transfer.provider_transfer_ref),
    readCancellationRequests(transfer.id),
    readDepositInstructions(transfer.id),
    readDisclosures(transfer.id),
    recordedReturnEvent(transfer.id, transfer.provider_transfer_ref),
  ])

  const ledgerKeySet = new Set(ledger.map((batch) => batch.idempotencyKey))

  return {
    generatedAt: new Date(nowMs).toISOString(),
    transfer: {
      transferId: transfer.id,
      state: transfer.state,
      sendAmountMinor: transfer.send_amount_minor,
      sendCurrency: transfer.send_currency,
      receiveAmountMinor: transfer.receive_amount_minor,
      receiveCurrency: transfer.receive_currency,
      feeAmountMinor: transfer.fee_amount_minor,
      marginMinor: transfer.margin_minor,
      fxRate: transfer.fx_rate,
      fundingSourceType: transfer.funding_source_type,
      fundingProcessor: processorNameFor(transfer),
      fundingCleared: transfer.funding_cleared,
      fundingPaymentRef: transfer.funding_payment_ref,
      providerTransferRef: transfer.provider_transfer_ref,
      refundPaymentRef: transfer.refund_payment_ref,
      payoutHoldReason: transfer.payout_hold_reason,
      payoutHeldAt: transfer.payout_held_at,
      submitAttemptedAt: transfer.submit_attempted_at,
      cancellationRequestedAt: transfer.cancellation_requested_at,
      paymentClaimedAt: transfer.payment_claimed_at,
      disclosureAcceptedAt: transfer.disclosure_accepted_at,
      paymentAt: transfer.payment_at,
      cancelableUntil: transfer.cancelable_until,
      completedAt: transfer.completed_at,
      refundedAt: transfer.refunded_at,
      createdAt: transfer.created_at,
      dwell: dwellFor(transfer, nowMs),
    },
    quote,
    destination,
    refund: {
      claimStatus: classifyRefundClaim(transfer.refund_claimed_at),
      claimedAt: transfer.refund_claimed_at,
      claimedBy: transfer.refund_claimed_by,
      returnEventType,
      // The two batches the refund tail posts (ledger-rules.md): their
      // presence is the operator's proof the money story is complete.
      ledgerKeys: {
        bridgeReturn: ledgerKeySet.has(`${transfer.id}:bridge_return`),
        refunded: ledgerKeySet.has(`${transfer.id}:REFUNDED`),
      },
    },
    transitions,
    ledger,
    paymentEvents,
    cancellationRequests,
    depositInstructions,
    disclosures,
  }
}
