// Dev driver for Bridge transfer webhooks — signs and POSTs a simulated
// transfer.updated.status_transitioned event so the /v1/webhooks/bridge
// transfer.* branch (payment_events insert → payment-event.process →
// SUBMITTED → IN_FLIGHT → COMPLETED / PAYOUT_FAILED) runs end-to-end without
// the Bridge sandbox. Mirrors scripts/fire-funding-webhook.ts, but Bridge
// signs RSA-PKCS1v15 instead of HMAC.
//
// Signing must match verifySignature() in src/routes/v1/webhooks.ts byte for
// byte: digest = sha256("{t}." + rawBody), then RSA-SHA256 sign the digest,
// base64. Header: x-webhook-signature: t=<ms>,v0=<base64>.
//
// Keypair: set BRIDGE_WEBHOOK_PRIVATE_KEY to a PEM private key to sign with a
// stable key (the funding driver's load-from-env pattern). If it is unset,
// this generates an ephemeral RSA-2048 keypair and prints the PUBLIC PEM —
// set BRIDGE_WEBHOOK_PUBLIC_KEY (server) to that value AND
// BRIDGE_WEBHOOK_PRIVATE_KEY (this driver) to the matching private key so
// subsequent runs verify against a server that already has the public key.
//
// Usage:
//   BRIDGE_WEBHOOK_PRIVATE_KEY="$(cat bridge-test.key)" \
//     pnpm exec tsx scripts/fire-bridge-webhook.ts \
//     <clientReferenceId> <bridgeTransferId> [state] [--url http://localhost:3001]
//
//   clientReferenceId  our transfer UUID (client_reference_id round-trip)
//   bridgeTransferId   Bridge's transfer id (event_object.id / provider ref)
//   state              Bridge transfer state to fire (default payment_processed)
//
// Base URL resolves to --url, then API_BASE, then http://localhost:3001.
// A script, not an HTTP surface: zero production attack surface.
import crypto from 'node:crypto'

const [clientReferenceId, bridgeTransferId, ...rest] = process.argv.slice(2)

const argValue = (flag: string): string | undefined => {
  const i = rest.indexOf(flag)
  return i === -1 ? undefined : rest[i + 1]
}

// First positional after the two required ids that is not a flag / flag value.
const positionalState = ((): string | undefined => {
  for (let i = 0; i < rest.length; i++) {
    const cur = rest[i]
    if (cur === undefined) continue
    if (cur.startsWith('--')) {
      i++ // skip the flag's value
      continue
    }
    return cur
  }
  return undefined
})()

if (!clientReferenceId || !bridgeTransferId) {
  console.error(
    'usage: [BRIDGE_WEBHOOK_PRIVATE_KEY=...] tsx scripts/fire-bridge-webhook.ts ' +
      '<clientReferenceId> <bridgeTransferId> [state] [--url <base>]',
  )
  process.exit(1)
}

const state = positionalState ?? 'payment_processed'
const baseUrl = argValue('--url') ?? process.env.API_BASE ?? 'http://localhost:3001'

// Load a stable private key from env, or mint an ephemeral one and print the
// matching public PEM for the operator to install as BRIDGE_WEBHOOK_PUBLIC_KEY.
let privateKey: crypto.KeyObject
const envKey = process.env.BRIDGE_WEBHOOK_PRIVATE_KEY
if (envKey) {
  // Match the server's env normalization: single-line PEMs use escaped \n.
  privateKey = crypto.createPrivateKey(envKey.replace(/\\n/g, '\n'))
} else {
  const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  privateKey = pair.privateKey
  const publicPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  console.error(
    'BRIDGE_WEBHOOK_PRIVATE_KEY not set — generated an ephemeral keypair.\n' +
      'Set the server BRIDGE_WEBHOOK_PUBLIC_KEY to the PEM below, or this POST ' +
      'will fail signature verification:\n' +
      publicPem,
  )
}

// Body shape mirrors BridgeWebhookEvent in webhooks.ts. state and status carry
// the same value so the transfer.* branch reads it under either field name;
// client_reference_id is the transfer UUID the processor resolves on.
const body = JSON.stringify({
  event_type: 'transfer.updated.status_transitioned',
  event_object_id: bridgeTransferId,
  event_object: {
    id: bridgeTransferId,
    state,
    status: state,
    client_reference_id: clientReferenceId,
  },
})
const rawBody = Buffer.from(body, 'utf8')

const t = Date.now()
// digest = sha256("{t}." + rawBody); RSA-SHA256 verify() re-hashes this digest,
// so sign the digest (not the raw body) — exactly what verifySignature reads.
const digest = crypto.createHash('sha256').update(`${t}.`).update(rawBody).digest()
const signer = crypto.createSign('RSA-SHA256')
signer.update(digest)
const v0 = signer.sign(privateKey, 'base64')

const res = await fetch(`${baseUrl}/v1/webhooks/bridge`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-webhook-signature': `t=${t},v0=${v0}`,
  },
  body: rawBody,
})

console.log(`${res.status} ${await res.text()}`)
process.exit(res.ok ? 0 : 1)
