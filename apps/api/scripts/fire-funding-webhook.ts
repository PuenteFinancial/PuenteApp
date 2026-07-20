// Dev trigger for the mock funding processor — signs and POSTs a simulated
// funding event so the full PENDING_PAYMENT → FUNDED path (webhook signature,
// transition RPC, ledger posting) runs end-to-end without Stripe.
//
// Usage:
//   MOCK_FUNDING_WEBHOOK_SECRET=... pnpm exec tsx scripts/fire-funding-webhook.ts \
//     <transferId> succeeded|failed|cleared|reversed [--url http://localhost:3001] [--reason R01]
//
// Works against localhost and staging (use the staging secret from Doppler).
// A script, not an HTTP surface: zero production attack surface.
import crypto from 'node:crypto'

const [transferId, kind, ...rest] = process.argv.slice(2)

const KINDS: Record<string, string> = {
  succeeded: 'funding_succeeded',
  failed: 'funding_failed',
  cleared: 'funding_cleared',
  reversed: 'funding_reversed',
}

const secret = process.env.MOCK_FUNDING_WEBHOOK_SECRET
if (!transferId || !kind || !KINDS[kind] || !secret) {
  console.error(
    'usage: MOCK_FUNDING_WEBHOOK_SECRET=... tsx scripts/fire-funding-webhook.ts <transferId> succeeded|failed|cleared|reversed [--url <base>] [--reason <code>]',
  )
  process.exit(1)
}

const argValue = (flag: string): string | undefined => {
  const i = rest.indexOf(flag)
  return i === -1 ? undefined : rest[i + 1]
}

const baseUrl = argValue('--url') ?? 'http://localhost:3001'
const reason = argValue('--reason')

const body = JSON.stringify({
  id: `evt_${crypto.randomUUID()}`,
  type: KINDS[kind],
  data: {
    transfer_id: transferId,
    payment_ref: `mockpay_${crypto.randomUUID()}`,
    ...(reason && { reason }),
  },
})

const t = Date.now()
const signature = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')

const res = await fetch(`${baseUrl}/v1/webhooks/funding`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Funding-Signature': `t=${t},v1=${signature}`,
  },
  body,
})

console.log(`${res.status} ${await res.text()}`)
process.exit(res.ok ? 0 : 1)
