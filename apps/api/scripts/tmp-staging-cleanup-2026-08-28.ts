// One-off staging cleanup (2026-08-28, delete after running). Safe to re-run:
// every step dedupes or replays as a no-op. Three parts:
//
// 1) Complete the two smoke payouts stuck in SUBMITTED (Bridge sandbox never
//    delivers): synthesize the poll's payment_processed event with the poll's
//    own (source, externalEventId) key and run the real processor, so the
//    COMPLETED ledger batch + receipt are posted by the owning code.
//    Sentry: NODE-Z/NODE-11 (1a334643), NODE-13/NODE-18 (e1494b05).
//
// 2) Refund the pre-guard $100 test send 9e386487 (PAYOUT_FAILED, unwound by
//    ops:joshua 8/26). It NEVER reached SUBMITTED (Bridge 400 loop — sandbox
//    treasury too small), so due_from_bridge was never opened and the standard
//    tail's bridge_return batch would push it negative. Mirror ONLY step 2+3
//    of refundPayoutFailure: mark disbursed (ops ref; unknown prefix reads as
//    undo mode 'refunded'), then PAYOUT_FAILED → REFUNDED with
//    refundedLedgerEntries. Sentry: NODE-17.
//
// 3) Report: ledger balances vs the Bridge sandbox wallet, and print the
//    alignment command for the float (Sentry NODE-A) if a diff remains.
//
//   node --env-file=.env --import tsx scripts/tmp-staging-cleanup-2026-08-28.ts
import { env } from '../src/config/env.js'
import { supabaseAdmin } from '../src/services/supabase.js'
import { recordEvent } from '../src/services/payment-events.js'
import { processPaymentEvent } from '../src/jobs/payment-event-process.js'
import { transitionTransfer, refundedLedgerEntries } from '../src/services/transfers.js'
import { getBridgeWalletBalances } from '../src/services/bridge.js'

// ── 1) complete the stuck sandbox payouts ──────────────────────────────────
const STUCK = [
  {
    transferId: '1a334643-2b7b-462e-ad5b-37bf387f3d20',
    bridgeId: 'd0c6d0b9-116c-4f58-9462-c1efcb40bf5a',
  },
  {
    transferId: 'e1494b05-70fb-405c-b09a-02a43dedda8f',
    bridgeId: '4cb09d9d-1ac9-4667-8060-7fc98387712c',
  },
]

for (const { transferId, bridgeId } of STUCK) {
  const { id, inserted, status } = await recordEvent({
    source: 'bridge_poll',
    externalEventId: `${bridgeId}:payment_processed`,
    eventType: 'payment_processed',
    transferId,
    providerRef: bridgeId,
    payload: {
      state: 'payment_processed',
      synthesized_from: 'ops-cleanup-2026-08-28',
      note: 'sandbox payout never completes on its own; simulated completion (Sentry NODE-Z/NODE-13)',
    },
  })
  console.log(`\n[complete] event ${id} inserted=${inserted} status=${status}`)
  await processPaymentEvent(id)
  const { data } = await supabaseAdmin
    .from('transfers')
    .select('id, state, completed_at')
    .eq('id', transferId)
    .maybeSingle()
  console.log(`[complete] ${JSON.stringify(data)}`)
}

// ── 2) refund the pre-submit PAYOUT_FAILED test send ───────────────────────
const REFUND_ID = '9e386487-36ec-4f58-b1fc-c999bc1c4fb8'
const OPS_REFUND_REF = 'opsrefund_staging-cleanup-2026-08-28'

const { data: refundRow, error: refundLoadError } = await supabaseAdmin
  .from('transfers')
  .select('id, state, send_amount_minor, fee_amount_minor, margin_minor, refund_payment_ref')
  .eq('id', REFUND_ID)
  .maybeSingle()
if (refundLoadError || !refundRow) throw new Error(`refund load failed: ${refundLoadError?.message}`)
const refund = refundRow as {
  state: string
  send_amount_minor: number
  fee_amount_minor: number
  margin_minor: number
  refund_payment_ref: string | null
}

if (refund.state === 'REFUNDED') {
  console.log('\n[refund] already REFUNDED — nothing to do')
} else if (refund.state !== 'PAYOUT_FAILED') {
  throw new Error(`[refund] unexpected state ${refund.state} — refusing to touch`)
} else {
  // Mirror of refundPayoutFailure step 2's persist, guarded the same way.
  const { error: persistError } = await supabaseAdmin
    .from('transfers')
    .update({ refund_payment_ref: OPS_REFUND_REF, refunded_at: new Date().toISOString() })
    .eq('id', REFUND_ID)
    .is('refund_payment_ref', null)
  if (persistError) throw new Error(`refund ref persist failed: ${persistError.message}`)

  const row = await transitionTransfer({
    transferId: REFUND_ID,
    fromState: 'PAYOUT_FAILED',
    toState: 'REFUNDED',
    actor: 'ops:claude-code',
    reason:
      'staging cleanup: pre-guard $100 test send, unwound by ops:joshua 8/26; payout never reached ' +
      'Bridge (no due_from_bridge opened) so bridge_return is deliberately skipped — refund batch only',
    ledgerDescription: 'transfer REFUNDED — payout failed before submission, sender refunded',
    ledgerEntries: refundedLedgerEntries(refund),
  })
  console.log(`\n[refund] ${JSON.stringify({ id: row.id, state: row.state })}`)
}

// ── 3) report: book vs sandbox wallet ──────────────────────────────────────
const { data: balances, error: balError } = await supabaseAdmin.rpc('account_balances')
let ledgerFloatMinor: number | null = null
if (balError || balances == null) {
  // No account_balances RPC in this schema — fall back to summing entries.
  const { data: rows, error } = await supabaseAdmin
    .from('ledger_entries')
    .select('direction, amount_minor, ledger_accounts:account_id ( code )')
  if (error || rows == null) throw new Error(`balance query failed: ${error?.message}`)
  const byCode = new Map<string, number>()
  for (const r of rows as unknown as Array<{
    direction: string
    amount_minor: number
    ledger_accounts: { code: string }
  }>) {
    const sign = r.direction === 'debit' ? 1 : -1
    byCode.set(
      r.ledger_accounts.code,
      (byCode.get(r.ledger_accounts.code) ?? 0) + sign * r.amount_minor,
    )
  }
  console.log('\n[report] ledger balances (minor units):')
  for (const [code, minor] of [...byCode.entries()].sort()) console.log(`  ${code}: ${minor}`)
  ledgerFloatMinor = byCode.get('bridge_wallet_float') ?? 0
} else {
  console.log('\n[report] ledger balances (minor units):')
  for (const b of balances as Array<{ code: string; balance_minor: number }>)
    console.log(`  ${b.code}: ${b.balance_minor}`)
  ledgerFloatMinor =
    (balances as Array<{ code: string; balance_minor: number }>).find(
      (b) => b.code === 'bridge_wallet_float',
    )?.balance_minor ?? 0
}

const walletId = env.BRIDGE_TREASURY_WALLET_ID
if (!walletId) {
  console.log('[report] no BRIDGE_TREASURY_WALLET_ID — skipping wallet comparison')
} else {
  const wallet = await getBridgeWalletBalances(walletId)
  let walletMinor = 0
  for (const b of wallet) {
    if (!['usdc', 'usdb'].includes(b.currency)) continue
    const m = /^(\d+)(?:\.(\d+))?$/.exec(b.balance)
    if (m) walletMinor += Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0').slice(0, 2))
  }
  const diff = walletMinor - ledgerFloatMinor
  console.log(`[report] wallet=${walletMinor} ledger_float=${ledgerFloatMinor} diff=${diff}`)
  if (diff > 0) {
    const dollars = (diff / 100).toFixed(2)
    console.log(
      `[report] to align (NODE-A): node --env-file=.env --import tsx scripts/record-float-topup.ts ` +
        `--amount ${dollars} --ref staging-alignment-2026-08-28 --confirm`,
    )
  } else if (diff < 0) {
    console.log(
      '[report] ledger is ABOVE the wallet — a top-up cannot fix this; a drawdown posting is needed. ' +
        'Stop and investigate before posting anything.',
    )
  } else {
    console.log('[report] float aligned — NODE-A should pass on the next recon run')
  }
}
