// Dev trigger for the mock funding processor — signs and POSTs a simulated
// funding event so the full PENDING_PAYMENT → FUNDED path (webhook signature,
// transition RPC, ledger posting) runs end-to-end without Stripe.
//
// Usage:
//   MOCK_FUNDING_WEBHOOK_SECRET=... pnpm exec tsx scripts/fire-funding-webhook.ts \
//     <transferId> succeeded|failed|cleared|reversed|refund-failed|refund-settled \
//     [--url http://localhost:3001] [--reason R01] [--undo-ref mockrefund_x]
//
// refund-failed / refund-settled (PR-S2) drill the undo tail on a transfer
// already at REFUNDED: pass --payment-ref as the transfer's funding_payment_ref
// (or rely on the metadata echo) and --undo-ref as the recorded
// refund_payment_ref so the page names the real disbursement.
//
// Works against localhost and staging (use the staging secret from Doppler).
//
// This script stays the operator-facing driver AND the escape hatch that works
// against any environment. The dev-gated POST /v1/dev/transfers/:id/
// simulate-funding endpoint (slice 7 PR3) is the in-app equivalent for the web
// "Simulate payment" button; both sign through buildMockFundingEvent so the
// wire format has exactly one definition. Importing it pulls in no env
// validation, so this still runs with nothing but the secret.
import type { FundingEventType } from '../src/services/funding/index.js'
import { buildMockFundingEvent } from '../src/services/funding/mock-events.js'

const [transferId, kind, ...rest] = process.argv.slice(2)

const KINDS: Record<string, FundingEventType> = {
  succeeded: 'funding_succeeded',
  failed: 'funding_failed',
  cleared: 'funding_cleared',
  reversed: 'funding_reversed',
  'refund-failed': 'refund_failed',
  'refund-settled': 'refund_settled',
}

const secret = process.env.MOCK_FUNDING_WEBHOOK_SECRET
if (!transferId || !kind || !KINDS[kind] || !secret) {
  console.error(
    'usage: MOCK_FUNDING_WEBHOOK_SECRET=... tsx scripts/fire-funding-webhook.ts <transferId> ' +
      'succeeded|failed|cleared|reversed|refund-failed|refund-settled ' +
      '[--url <base>] [--reason <code>] [--payment-ref <ref>] [--undo-ref <ref>]',
  )
  process.exit(1)
}

const argValue = (flag: string): string | undefined => {
  const i = rest.indexOf(flag)
  return i === -1 ? undefined : rest[i + 1]
}

const baseUrl = argValue('--url') ?? 'http://localhost:3001'
const reason = argValue('--reason')
const paymentRef = argValue('--payment-ref')
const undoRef = argValue('--undo-ref')

const { body, signature } = buildMockFundingEvent({
  transferId,
  type: KINDS[kind],
  secret,
  ...(paymentRef && { paymentRef }),
  ...(undoRef && { undoRef }),
  ...(reason && { reason }),
})

const res = await fetch(`${baseUrl}/v1/webhooks/funding`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Funding-Signature': signature,
  },
  body,
})

console.log(`${res.status} ${await res.text()}`)
process.exit(res.ok ? 0 : 1)
