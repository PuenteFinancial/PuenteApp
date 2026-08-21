import { env } from '../config/env.js'
import { supabaseAdmin } from './supabase.js'
import { getAccountBalance } from './ledger.js'
import { getBridgeWalletBalances, listBridgeTransfers } from './bridge.js'
import { getFundingProcessor } from './funding/index.js'
import { pollPayouts } from '../jobs/payout-poll.js'

// The reconciliation checks registry (slice-8 O2, docs/runbooks/reconciliation.md).
// The daily `ledger.reconcile` cron runs every check, persists one
// reconciliation_runs row, and pages Sentry per finding. Design rules:
//
//   * The ledger is Puente's book — providers are reconciled AGAINST it.
//   * Money discrepancies are NEVER auto-adjusted. The only sanctioned
//     auto-action is replaying a missed webhook through the idempotent
//     worker path (the bridge_state_sweep check = pollPayouts).
//   * A failed ledger SELF-check is a code bug → highest severity page.
//   * Checks that need external truth we can't reach (mock funding processor,
//     no treasury wallet id) report `skipped`, never a fake pass.
//   * Findings carry ids/refs/counts only — no names, no amounts beyond what
//     the ledger already holds, no provider payloads, no PII.

export type CheckStatus = 'pass' | 'findings' | 'skipped' | 'error'
export type CheckSeverity = 'fatal' | 'error' | 'warning'

export interface CheckFinding {
  /** Stable dedupe key — the Sentry fingerprint component (ids/refs only). */
  key: string
  detail: Record<string, unknown>
}

export interface CheckOutcome {
  status: CheckStatus
  findings: CheckFinding[]
  /** Small JSON summary persisted to the run row (counts/refs only). */
  summary?: Record<string, unknown>
  /** Only the account_balances check sets this — the run row's snapshot. */
  balances?: Record<string, { amount_minor: number; currency: string }>
}

export interface ReconciliationCheck {
  name: string
  severity: CheckSeverity
  runbook: string
  run(): Promise<CheckOutcome>
}

const RUNBOOK = 'docs/runbooks/reconciliation.md'

// ── Timing windows (docs/runbooks/reconciliation.md "known timing windows") ──
// Constants, not env: these encode process reality (auto-fail clocks, SPEI
// settle-in-seconds, ACH T+4), not tunable policy. Business-day-blind on
// purpose — at daily cadence a weekend false-positive costs one glance.
// (PENDING_PAYMENT is the one rail-aware bound: it mirrors whatever clock
// reconcile-pending itself runs on, which IS env under the manual rail.)
const PENDING_PAYMENT_STALE_WEBHOOK_MS = 40 * 60_000 // 30-min auto-fail + grace
// The reaper sweeps on a minutes-scale cron; hours of grace means a hit is
// the reaper being broken, never the reaper being between runs.
const PENDING_PAYMENT_REAPER_GRACE_MS = 6 * 60 * 60_000

// Rail-aware bound for the pending-payment-autofail-dead bucket (#216, the
// #205 fix mirrored): under the manual rail a sender legitimately holds
// deposit instructions for hours-to-days, and reconcile-pending waits
// MANUAL_PENDING_MAX_AGE_DAYS before reaping — so only past THAT clock (plus
// grace) does a PENDING_PAYMENT row mean the reaper is dead. Webhook rails
// keep the 40-minute bound.
function pendingPaymentStaleMs(): number {
  if (env.FUNDING_PROCESSOR !== 'manual') return PENDING_PAYMENT_STALE_WEBHOOK_MS
  return env.MANUAL_PENDING_MAX_AGE_DAYS * 24 * 60 * 60_000 + PENDING_PAYMENT_REAPER_GRACE_MS
}
const FUNDED_UNHELD_STALE_MS = 2 * 60 * 60_000 // sweep enqueues every minute; hours stuck = pipeline down
const SUBMITTED_STALE_MS = 24 * 60 * 60_000 // SPEI settles in seconds; a day in transit is stuck
const PAYOUT_FAILED_UNREFUNDED_STALE_MS = 24 * 60 * 60_000 // sender owed, nothing in motion
const UNDER_REVIEW_STALE_MS = 24 * 60 * 60_000 // cancellation-review SLA guard (O1 owns the business-day version)
const FUNDING_UNCLEARED_STALE_MS = 8 * 24 * 60 * 60_000 // ACH T+4 business days + weekend buffer
const ORPHAN_WINDOW_MS = 7 * 24 * 60 * 60_000
const LIST_LIMIT = 100
// PostgREST caps every response at max_rows (1000, supabase/config.toml) no
// matter the requested limit, so a response AT the cap is indistinguishable
// from a truncated one — treat reaching it as overflow and fail loud (an
// exactly-1000-row book trips a false positive, which is the right failure
// direction; a review pass found the "one past the cap" variant of this guard
// is unreachable and therefore dead).
const ROW_BOUND = 1000

const failClosed = (label: string, error: { message: string } | null): never => {
  throw new Error(`${label} failed: ${error?.message ?? 'no rows returned'}`)
}

const assertBound = (label: string, rows: unknown[]): void => {
  if (rows.length >= ROW_BOUND) {
    throw new Error(
      `${label}: read hit the ${ROW_BOUND}-row PostgREST cap — results may be silently truncated; move this check into SQL`,
    )
  }
}

// Provider refs echoed back from FOREIGN objects (Bridge client_reference_id,
// Stripe metadata.transfer_id) are attacker-of-convenience strings: a
// non-UUID value fed into a `.in('id', …)` lookup 22P02s the whole check on
// exactly the object it exists to flag. Only UUID-shaped refs join; the rest
// simply match nothing and surface as orphans.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ── Ledger self-checks (SQL functions from the O2 migration) ────────────────

interface NetZeroRow {
  ledger_transaction_id: string
  currency: string
  net_minor: number
}

async function runNetZero(): Promise<CheckOutcome> {
  const { data, error } = await supabaseAdmin.rpc('reconcile_ledger_net_zero')
  if (error || data == null) failClosed('reconcile_ledger_net_zero', error)
  const rows = data as NetZeroRow[]
  return {
    status: rows.length === 0 ? 'pass' : 'findings',
    findings: rows.map((row) => ({
      key: `net-zero:${row.ledger_transaction_id}:${row.currency.trim()}`,
      detail: {
        ledgerTransactionId: row.ledger_transaction_id,
        currency: row.currency.trim(),
        netMinor: row.net_minor,
      },
    })),
  }
}

interface MinEntriesRow {
  ledger_transaction_id: string
  entry_count: number
}

async function runMinEntries(): Promise<CheckOutcome> {
  const { data, error } = await supabaseAdmin.rpc('reconcile_ledger_min_entries')
  if (error || data == null) failClosed('reconcile_ledger_min_entries', error)
  const rows = data as MinEntriesRow[]
  return {
    status: rows.length === 0 ? 'pass' : 'findings',
    findings: rows.map((row) => ({
      key: `min-entries:${row.ledger_transaction_id}`,
      detail: {
        ledgerTransactionId: row.ledger_transaction_id,
        entryCount: Number(row.entry_count),
      },
    })),
  }
}

interface StatePostingsRow {
  transfer_id: string
  state: string
  problem: string
}

async function runStatePostings(): Promise<CheckOutcome> {
  const { data, error } = await supabaseAdmin.rpc('reconcile_state_postings')
  if (error || data == null) failClosed('reconcile_state_postings', error)
  const rows = data as StatePostingsRow[]
  return {
    status: rows.length === 0 ? 'pass' : 'findings',
    findings: rows.map((row) => ({
      key: `state-postings:${row.transfer_id}:${row.problem}`,
      detail: { transferId: row.transfer_id, state: row.state, problem: row.problem },
    })),
  }
}

// ── Account balances snapshot + negative open-item guard ────────────────────

// Accounts where a negative balance means over-relief (more credited out than
// ever recognized) — arithmetic impossibility in a correct posting history.
// cash_clearing is deliberately absent: at pilot it can go legitimately
// negative (fee refunds paid out while ACH settlements are not yet booked —
// the phase-2 cash-leg gap documented in the runbook).
const OPEN_ITEM_ACCOUNTS = new Set([
  'funding_receivable',
  'due_from_bridge',
  'transfer_payable',
  'refunds_payable',
  'bridge_wallet_float',
])

interface BalanceRow {
  code: string
  amount_minor: number
  currency: string
}

async function runAccountBalances(): Promise<CheckOutcome> {
  const { data, error } = await supabaseAdmin.rpc('reconcile_account_balances')
  if (error || data == null) failClosed('reconcile_account_balances', error)
  const rows = data as BalanceRow[]
  const balances: Record<string, { amount_minor: number; currency: string }> = {}
  const findings: CheckFinding[] = []
  for (const row of rows) {
    const amountMinor = Number(row.amount_minor)
    balances[row.code] = { amount_minor: amountMinor, currency: row.currency.trim() }
    if (OPEN_ITEM_ACCOUNTS.has(row.code) && amountMinor < 0) {
      findings.push({
        key: `negative-balance:${row.code}`,
        detail: { accountCode: row.code, amountMinor },
      })
    }
  }
  return {
    status: findings.length === 0 ? 'pass' : 'findings',
    findings,
    balances,
  }
}

// ── Transfer aging vs known timing windows ──────────────────────────────────

interface AgingRow {
  id: string
  state: string
  created_at: string
  payment_at: string | null
  submit_attempted_at: string | null
  completed_at: string | null
  refund_payment_ref: string | null
  payout_hold_reason: string | null
  funding_cleared: boolean
}

// Latest of the write-once lifecycle stamps — the closest safe approximation
// of "when this row entered its current tail" without reading
// transfer_transitions. updated_at is deliberately NOT used: it moves on any
// lifecycle write and would reset the clock exactly when something touches a
// stuck row.
function latestLifecycleStamp(row: AgingRow): string {
  let latest = row.created_at
  for (const stamp of [row.payment_at, row.submit_attempted_at, row.completed_at]) {
    if (stamp != null && stamp > latest) latest = stamp
  }
  return latest
}

// Exported for tests: pure bucketing over the selected rows. `payment_at`
// (set once at FUNDED) is the age anchor for the funding-window buckets; the
// PAYOUT_FAILED and UNDER_REVIEW buckets anchor on the latest lifecycle stamp
// instead — a first-transfer-held row is legitimately days past funding when
// its payout first fails, and a funding-time anchor would page the moment it
// entered the tail state rather than 24h into it (review finding).
export function agingFindings(rows: AgingRow[], nowMs: number): CheckFinding[] {
  const findings: CheckFinding[] = []
  const flag = (bucket: string, row: AgingRow, anchorIso: string) => {
    findings.push({
      key: `aging:${bucket}:${row.id}`,
      detail: {
        transferId: row.id,
        state: row.state,
        bucket,
        anchorAt: anchorIso,
        ageHours: Math.round((nowMs - new Date(anchorIso).getTime()) / 3600_000),
      },
    })
  }
  for (const row of rows) {
    const funded = row.payment_at ?? row.created_at
    const fundedAge = nowMs - new Date(funded).getTime()
    switch (row.state) {
      case 'PENDING_PAYMENT':
        if (nowMs - new Date(row.created_at).getTime() > pendingPaymentStaleMs())
          flag('pending-payment-autofail-dead', row, row.created_at)
        break
      case 'FUNDED':
        if (row.payout_hold_reason == null) {
          if (fundedAge > FUNDED_UNHELD_STALE_MS) flag('funded-unheld-stuck', row, funded)
        } else if (fundedAge > FUNDING_UNCLEARED_STALE_MS) {
          // Held rows legitimately dwell until clearing (~T+4) — only flag
          // past the same bound as the uncleared-funding window.
          flag('funded-held-overdue', row, funded)
        }
        break
      case 'SUBMITTED':
      case 'IN_FLIGHT':
        if (fundedAge > SUBMITTED_STALE_MS) flag('payout-in-transit-stuck', row, funded)
        break
      case 'PAYOUT_FAILED': {
        const entered = latestLifecycleStamp(row)
        if (
          row.refund_payment_ref == null &&
          nowMs - new Date(entered).getTime() > PAYOUT_FAILED_UNREFUNDED_STALE_MS
        )
          flag('payout-failed-unrefunded', row, entered)
        break
      }
      case 'UNDER_REVIEW': {
        const entered = latestLifecycleStamp(row)
        if (nowMs - new Date(entered).getTime() > UNDER_REVIEW_STALE_MS)
          flag('under-review-aging', row, entered)
        break
      }
      default:
        break
    }
    // Receivable aging, orthogonal to state: an ACH pull past the settlement
    // window with no funding_cleared means either a missed `succeeded` webhook
    // or a debit genuinely stuck at the bank — both need eyes (and O3's
    // uncleared cap keeps blocking the sender until this resolves).
    if (
      ['FUNDED', 'SUBMITTED', 'IN_FLIGHT', 'COMPLETED'].includes(row.state) &&
      !row.funding_cleared &&
      fundedAge > FUNDING_UNCLEARED_STALE_MS
    ) {
      flag('funding-uncleared-overdue', row, funded)
    }
  }
  return findings
}

// Non-terminal states + COMPLETED-but-uncleared, one bounded read.
const AGING_OR_FILTER =
  'state.in.(PENDING_PAYMENT,FUNDED,SUBMITTED,IN_FLIGHT,PAYOUT_FAILED,UNDER_REVIEW),and(state.eq.COMPLETED,funding_cleared.eq.false)'

async function runTransferAging(): Promise<CheckOutcome> {
  const { data, error } = await supabaseAdmin
    .from('transfers')
    .select(
      'id, state, created_at, payment_at, submit_attempted_at, completed_at, refund_payment_ref, payout_hold_reason, funding_cleared',
    )
    .or(AGING_OR_FILTER)
    .limit(ROW_BOUND)
  if (error || data == null) failClosed('transfer-aging select', error)
  const rows = data as AgingRow[]
  assertBound('transfer-aging', rows)
  const findings = agingFindings(rows, Date.now())
  return {
    status: findings.length === 0 ? 'pass' : 'findings',
    findings,
    summary: { openRows: rows.length },
  }
}

// ── Bridge state sweep (the one sanctioned auto-action) ─────────────────────

// pollPayouts IS the idempotent replay path: it re-reads every in-flight
// Bridge transfer and synthesizes the missed event through recordEvent (which
// dedupes) + the normal processing job. It runs every few minutes on its own
// cron — anything this daily pass still synthesizes was missed for hours, so
// each synthesis is itself a finding (the self-heal already happened; the
// finding is "the poller has a gap").
async function runBridgeStateSweep(): Promise<CheckOutcome> {
  const synthesized = await pollPayouts()
  return {
    status: synthesized === 0 ? 'pass' : 'findings',
    findings:
      synthesized === 0
        ? []
        : [{ key: 'bridge-sweep-synthesized', detail: { synthesized } }],
    summary: { synthesized },
  }
}

// ── Bridge orphan detection ─────────────────────────────────────────────────

async function runBridgeOrphans(): Promise<CheckOutcome> {
  const listed = await listBridgeTransfers(LIST_LIMIT)
  const cutoffMs = Date.now() - ORPHAN_WINDOW_MS
  const recent = listed.filter((t) => {
    const created = new Date(t.createdAt).getTime()
    return Number.isFinite(created) && created >= cutoffMs
  })
  const truncated = listed.length >= LIST_LIMIT

  const findings: CheckFinding[] = []
  if (truncated) {
    // A full page means the window view is INCOMPLETE — page it rather than
    // let a silently capped list impersonate a clean sweep (review finding).
    // Note the newest-first ordering of the list is a Bridge default we rely
    // on; this finding is also the tripwire if that assumption ever breaks.
    findings.push({ key: 'bridge-orphans-truncated', detail: { listed: listed.length } })
  }
  if (recent.length > 0) {
    const ids = recent.map((t) => t.bridgeTransferId)
    const refIds = recent
      .map((t) => t.clientReferenceId)
      .filter((id): id is string => typeof id === 'string' && UUID_RE.test(id))

    const { data: byRef, error: refError } = await supabaseAdmin
      .from('transfers')
      .select('provider_transfer_ref')
      .in('provider_transfer_ref', ids)
    if (refError || byRef == null) failClosed('bridge-orphans provider_ref select', refError)
    const known = new Set(
      (byRef as { provider_transfer_ref: string | null }[]).map((r) => r.provider_transfer_ref),
    )

    // Second chance via client_reference_id: a crash between the Bridge POST
    // and persisting provider_transfer_ref leaves a legitimate transfer whose
    // ref column is still null — the payout-submit recovery path owns those,
    // and they must not page as orphans.
    let knownByClientRef = new Set<string>()
    if (refIds.length > 0) {
      const { data: byId, error: idError } = await supabaseAdmin
        .from('transfers')
        .select('id')
        .in('id', refIds)
      if (idError || byId == null) failClosed('bridge-orphans client_ref select', idError)
      knownByClientRef = new Set((byId as { id: string }[]).map((r) => r.id))
    }

    for (const t of recent) {
      const matched =
        known.has(t.bridgeTransferId) ||
        (t.clientReferenceId != null && knownByClientRef.has(t.clientReferenceId))
      if (!matched) {
        findings.push({
          key: `bridge-orphan:${t.bridgeTransferId}`,
          detail: {
            bridgeTransferId: t.bridgeTransferId,
            clientReferenceId: t.clientReferenceId,
            bridgeState: t.state,
            createdAt: t.createdAt,
          },
        })
      }
    }
  }

  return {
    status: findings.length === 0 ? 'pass' : 'findings',
    findings,
    summary: {
      listed: listed.length,
      inWindow: recent.length,
      windowDays: ORPHAN_WINDOW_MS / (24 * 60 * 60_000),
      // no-silent-caps: a full page means the window view is incomplete.
      truncated,
    },
  }
}

// ── Treasury wallet float vs bridge_wallet_float ────────────────────────────

/**
 * Par conversion of a Bridge decimal balance string ("5.69") to USD minor
 * units. String math — never parseFloat on money. Sub-cent dust is dropped
 * but reported, so a dusty wallet doesn't page a phantom cent forever.
 */
export function parMinorFromDecimal(balance: string): { minor: number; dustDropped: boolean } {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(balance)
  if (!match) throw new Error(`unparseable wallet balance: ${balance}`)
  const frac = (match[2] ?? '').padEnd(2, '0')
  return {
    minor: Number(match[1]) * 100 + Number(frac.slice(0, 2)),
    dustDropped: /[1-9]/.test(frac.slice(2)),
  }
}

// USD-pegged stables the treasury may hold at par (USDB = Bridge's
// yield-bearing variant; sandbox holds both).
const PAR_STABLE_CURRENCIES = new Set(['usdc', 'usdb'])

async function runBridgeWalletFloat(): Promise<CheckOutcome> {
  const walletId = env.BRIDGE_TREASURY_WALLET_ID
  if (!walletId) {
    return { status: 'skipped', findings: [], summary: { reason: 'no BRIDGE_TREASURY_WALLET_ID' } }
  }
  const balances = await getBridgeWalletBalances(walletId)
  let walletMinor = 0
  let dustDropped = false
  for (const b of balances) {
    if (!PAR_STABLE_CURRENCIES.has(b.currency)) continue
    const parsed = parMinorFromDecimal(b.balance)
    walletMinor += parsed.minor
    dustDropped ||= parsed.dustDropped
  }
  const ledger = await getAccountBalance('bridge_wallet_float')
  const diffMinor = walletMinor - ledger.amountMinor
  const findings: CheckFinding[] =
    diffMinor === 0
      ? []
      : [
          {
            key: 'bridge-wallet-float-mismatch',
            detail: {
              walletMinor,
              ledgerMinor: ledger.amountMinor,
              diffMinor,
              dustDropped,
            },
          },
        ]
  return {
    status: findings.length === 0 ? 'pass' : 'findings',
    findings,
    summary: { walletMinor, ledgerMinor: ledger.amountMinor, diffMinor, dustDropped },
  }
}

// ── Stripe legs (detection-only; skipped under mock) ────────────────────────
// There is no funding-side replay path (funding webhooks are handled inline in
// the route), so these checks DETECT and page — the runbook's action is
// resending the event from the Stripe dashboard, which the idempotent webhook
// route dedupes. Never auto-adjust from here.

interface StripeCandidateRow {
  id: string
  state: string
  funding_payment_ref: string
  funding_cleared: boolean
  refund_payment_ref: string | null
}

// Exported for tests: classify one transfer against its live PI status.
export function classifyStripeStatus(
  row: StripeCandidateRow,
  piStatus: string,
): CheckFinding | null {
  const detail = {
    transferId: row.id,
    state: row.state,
    paymentRef: row.funding_payment_ref,
    piStatus,
  }
  if (row.state === 'PENDING_PAYMENT') {
    // The sender's money is (or will be) pulled but our row never advanced —
    // the 30-min auto-fail will (or did) fire against a live debit.
    if (piStatus === 'processing' || piStatus === 'succeeded') {
      return { key: `stripe-missed-processing:${row.id}`, detail }
    }
    return null // requires_* (awaiting the sender) and canceled are routine here
  }
  if (row.state === 'PAYMENT_FAILED' || row.state === 'CANCELED') {
    // The dead-transfer arm (review finding): reconcile-pending auto-fails a
    // stale PENDING_PAYMENT without touching the PI, so a missed `processing`
    // webhook leaves the ACH pull marching to settlement against a transfer we
    // consider dead — the sender is debited and NOTHING else watches this.
    // A live/settled PI beside a null refund_payment_ref pages; with an undo
    // ref present the void-fell-back-to-refund path already owns the money
    // truth (a settled PI is expected there while the refund tail runs).
    if (
      row.refund_payment_ref == null &&
      (piStatus === 'processing' || piStatus === 'succeeded')
    ) {
      return { key: `stripe-debit-on-dead-transfer:${row.id}`, detail }
    }
    return null
  }
  // Past FUNDED the pull must be live (processing) or settled (succeeded).
  if (piStatus === 'canceled' || piStatus.startsWith('requires_')) {
    return { key: `stripe-pi-regressed:${row.id}`, detail }
  }
  if (piStatus === 'succeeded' && !row.funding_cleared) {
    // Missed payment_intent.succeeded: funding_cleared never flipped, and
    // O3's uncleared cap keeps blocking this sender until it does.
    return { key: `stripe-missed-cleared:${row.id}`, detail }
  }
  return null
}

// Live/committed states always sweep; the dead states (PAYMENT_FAILED,
// CANCELED — the debit-on-dead-transfer arm) are windowed to recent rows: a
// PI's status can only still change within the ACH settlement horizon, and an
// unbounded terminal backlog would grow one Stripe read per dead row forever.
const STRIPE_TERMINAL_WINDOW_MS = 14 * 24 * 60 * 60_000

function stripeOrFilter(nowMs: number): string {
  const terminalCutoff = new Date(nowMs - STRIPE_TERMINAL_WINDOW_MS).toISOString()
  return (
    'state.in.(PENDING_PAYMENT,FUNDED,SUBMITTED,IN_FLIGHT),' +
    'and(state.eq.COMPLETED,funding_cleared.eq.false),' +
    `and(state.in.(PAYMENT_FAILED,CANCELED),created_at.gte.${terminalCutoff})`
  )
}

async function runStripeReceivables(): Promise<CheckOutcome> {
  const processor = getFundingProcessor()
  if (processor.provider !== 'stripe' || !processor.isConfigured() || !processor.getPaymentStatus) {
    return { status: 'skipped', findings: [], summary: { reason: 'funding processor is not stripe' } }
  }
  const { data, error } = await supabaseAdmin
    .from('transfers')
    .select('id, state, funding_payment_ref, funding_cleared, refund_payment_ref')
    .like('funding_payment_ref', 'pi_%')
    .or(stripeOrFilter(Date.now()))
    .limit(ROW_BOUND)
  if (error || data == null) failClosed('stripe-receivables select', error)
  const rows = data as StripeCandidateRow[]
  assertBound('stripe-receivables', rows)

  const findings: CheckFinding[] = []
  const readFailures: string[] = []
  for (const row of rows) {
    try {
      const status = await processor.getPaymentStatus({ paymentRef: row.funding_payment_ref })
      const finding = classifyStripeStatus(row, status.status)
      if (finding) findings.push(finding)
    } catch (err) {
      // One PI read failing must not blind the rest of the sweep — but a
      // partial sweep is an 'error' outcome, never a clean pass.
      readFailures.push(err instanceof Error ? err.message : String(err))
    }
  }
  return {
    status: readFailures.length > 0 ? 'error' : findings.length === 0 ? 'pass' : 'findings',
    findings,
    summary: {
      checked: rows.length,
      readFailures: readFailures.length,
      ...(readFailures.length > 0 && { firstReadFailure: readFailures[0] }),
    },
  }
}

async function runStripeOrphans(): Promise<CheckOutcome> {
  const processor = getFundingProcessor()
  if (
    processor.provider !== 'stripe' ||
    !processor.isConfigured() ||
    !processor.listRecentPayments
  ) {
    return { status: 'skipped', findings: [], summary: { reason: 'funding processor is not stripe' } }
  }
  const listed = await processor.listRecentPayments({
    createdAfter: new Date(Date.now() - ORPHAN_WINDOW_MS),
    limit: LIST_LIMIT,
  })
  const truncated = listed.length >= LIST_LIMIT

  const findings: CheckFinding[] = []
  if (truncated) {
    // Same silent-cap rule as bridge_orphans: an incomplete window pages.
    findings.push({ key: 'stripe-orphans-truncated', detail: { listed: listed.length } })
  }
  // Non-UUID echoes can't be our transfers — leave them out of the lookup
  // (22P02 guard) and let them fall through as orphans below.
  const withRef = listed.filter((p) => p.transferRef != null && UUID_RE.test(p.transferRef))
  let knownIds = new Set<string>()
  if (withRef.length > 0) {
    const { data, error } = await supabaseAdmin
      .from('transfers')
      .select('id')
      .in('id', withRef.map((p) => p.transferRef as string))
    if (error || data == null) failClosed('stripe-orphans select', error)
    knownIds = new Set((data as { id: string }[]).map((r) => r.id))
  }
  for (const p of listed) {
    if (p.transferRef == null || !knownIds.has(p.transferRef)) {
      findings.push({
        key: `stripe-orphan:${p.paymentRef}`,
        detail: {
          paymentRef: p.paymentRef,
          transferRef: p.transferRef,
          piStatus: p.status,
          createdAt: p.createdAt,
        },
      })
    }
  }
  return {
    status: findings.length === 0 ? 'pass' : 'findings',
    findings,
    summary: {
      listed: listed.length,
      windowDays: ORPHAN_WINDOW_MS / (24 * 60 * 60_000),
      truncated,
    },
  }
}

// ── The registry ────────────────────────────────────────────────────────────
// Order matters only for readability of the run row: book first, then aging,
// then providers. Severities: ledger self-checks page FATAL (a non-balancing
// book is a code bug — stop and investigate); orphans and Stripe mismatches
// page ERROR (money outside the state machine / senders blocked); aging,
// sweep gaps, and float drift page WARNING (need eyes, not a fire).

export function buildChecks(): ReconciliationCheck[] {
  return [
    { name: 'ledger_net_zero', severity: 'fatal', runbook: RUNBOOK, run: runNetZero },
    { name: 'ledger_min_entries', severity: 'fatal', runbook: RUNBOOK, run: runMinEntries },
    { name: 'state_postings', severity: 'fatal', runbook: RUNBOOK, run: runStatePostings },
    { name: 'account_balances', severity: 'fatal', runbook: RUNBOOK, run: runAccountBalances },
    { name: 'transfer_aging', severity: 'warning', runbook: RUNBOOK, run: runTransferAging },
    { name: 'bridge_state_sweep', severity: 'warning', runbook: RUNBOOK, run: runBridgeStateSweep },
    { name: 'bridge_orphans', severity: 'error', runbook: RUNBOOK, run: runBridgeOrphans },
    { name: 'bridge_wallet_float', severity: 'warning', runbook: RUNBOOK, run: runBridgeWalletFloat },
    { name: 'stripe_receivables', severity: 'error', runbook: RUNBOOK, run: runStripeReceivables },
    { name: 'stripe_orphans', severity: 'error', runbook: RUNBOOK, run: runStripeOrphans },
  ]
}
