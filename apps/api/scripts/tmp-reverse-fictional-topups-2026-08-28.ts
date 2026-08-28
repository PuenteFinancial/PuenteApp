// One-off staging correction (2026-08-28, delete after running). Safe to
// re-run: each reversal has its own idempotency key.
//
// Every float top-up booked since the 8/19 alignment was auto-booked against a
// FICTIONAL sandbox delivery — Bridge sandbox draws real USDC for payouts but
// never lands onramp deposits, so the wallet never received these amounts.
// Recon 2026-08-28 12:00 UTC: ledger 16806 vs wallet 5506, diff −11300 = the
// four top-ups below exactly. Reverse them (DR cash_clearing / CR
// bridge_wallet_float); after this the float reads 5506 == wallet. Sentry:
// NODE-A.
//
//   node --env-file=.env --import tsx scripts/tmp-reverse-fictional-topups-2026-08-28.ts
import { postLedgerTransaction } from '../src/services/ledger.js'
import { supabaseAdmin } from '../src/services/supabase.js'

const FICTIONAL_TOPUPS: Array<{ ref: string; amountMinor: number }> = [
  { ref: 'adhoc:smoke-topup-1787325284', amountMinor: 100 },
  { ref: '3406220f-fdc3-419c-8a4e-e19451de163f', amountMinor: 200 },
  { ref: 'cos_1U8Sp0IbCQghJX8Liog4IDv1', amountMinor: 1000 },
  { ref: 'cos_1U8TTOIbCQghJX8LaLVgafI3', amountMinor: 10000 },
]

for (const { ref, amountMinor } of FICTIONAL_TOPUPS) {
  await postLedgerTransaction({
    idempotencyKey: `float_topup_reversal:${ref}`,
    description: `reverse fictional sandbox top-up (${ref}) — delivery never landed in the wallet`,
    entries: [
      {
        accountCode: 'cash_clearing',
        direction: 'debit',
        money: { amountMinor, currency: 'USD' },
      },
      {
        accountCode: 'bridge_wallet_float',
        direction: 'credit',
        money: { amountMinor, currency: 'USD' },
      },
    ],
  })
  console.log(`reversed ${ref}: ${amountMinor} minor`)
}

const { data, error } = await supabaseAdmin
  .from('ledger_entries')
  .select('direction, amount_minor, ledger_accounts:account_id ( code )')
if (error || data == null) throw new Error(`balance query failed: ${error?.message}`)
let float = 0
for (const r of data as unknown as Array<{
  direction: string
  amount_minor: number
  ledger_accounts: { code: string }
}>) {
  if (r.ledger_accounts.code !== 'bridge_wallet_float') continue
  float += (r.direction === 'debit' ? 1 : -1) * r.amount_minor
}
console.log(`bridge_wallet_float after: ${float} minor (target 5506 == wallet at 12:00 UTC recon)`)
