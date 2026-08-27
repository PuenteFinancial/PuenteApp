// Smoke-test the Stripe crypto onramp credentials + provisioning (K3).
//
// The embedded-components API is a private preview: no call succeeds until
// Stripe provisions the account's feature flags — including in a sandbox.
// This script exists to tell WHICH of three worlds we're in:
//   1. Creds missing/invalid            → fix Doppler
//   2. Creds valid, flags not provisioned → the documented
//      "Unrecognized request URL" — Stripe SA fix, NOT a code bug
//   3. Fully provisioned                → K3's assumptions hold; K4/K5 can
//      build against live sandbox responses
//
// Read-only by construction: it creates one LinkAuthIntent (an intent is
// inert — no OTP is sent until an SDK presents it) and prices one headless
// quote. It never touches the database, never mints tokens, and never
// creates sessions. transaction_limits is deliberately NOT probed: it needs
// a consented user token, which doesn't exist until K5's UI runs.
//
// Usage:
//   node --env-file=.env.e2e.local --import tsx scripts/smoke-stripe-crypto.ts
//   doppler run -- pnpm exec tsx scripts/smoke-stripe-crypto.ts   (sandbox creds via Doppler)

import { env } from '../src/config/env.js'

const PROBE_EMAIL = process.env.SMOKE_PROBE_EMAIL ?? 'onramp-smoke@puentefinancial.com'

interface ProbeResult {
  name: string
  verdict: string
  detail?: string | undefined
}

function classifyStatus(status: number, body: unknown): { verdict: string; detail?: string | undefined } {
  const message =
    typeof body === 'object' && body !== null
      ? ((body as { error?: { message?: string; code?: string } }).error?.message ?? '')
      : ''
  if (message.includes('Unrecognized request URL')) {
    return {
      verdict: 'NOT PROVISIONED (expected pre-onboarding)',
      detail: 'Account flags missing — ask the Stripe SA to provision; not a code bug.',
    }
  }
  if (status === 401) return { verdict: 'BAD PLATFORM KEY', detail: 'STRIPE_SECRET_KEY rejected.' }
  if (status === 403) {
    return {
      verdict: 'NOT ENABLED / BAD OAUTH CLIENT',
      detail: 'Key valid but the feature or OAuth client is not enabled for this account.',
    }
  }
  const code =
    typeof body === 'object' && body !== null
      ? ((body as { error?: { code?: string } }).error?.code ?? '')
      : ''
  return { verdict: `HTTP ${status}`, detail: code || message || undefined }
}

async function probeLinkAuthIntent(): Promise<ProbeResult> {
  const name = 'LinkAuthIntent create (login.link.com)'
  const res = await fetch(`${env.LINK_OAUTH_API_BASE}/v1/link_auth_intent`, {
    method: 'POST',
    signal: AbortSignal.timeout(env.STRIPE_TIMEOUT_SECONDS * 1000),
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: PROBE_EMAIL,
      oauth_client_id: env.STRIPE_CRYPTO_OAUTH_CLIENT_ID,
      oauth_scopes: 'kyc.status:read,crypto:ramp',
    }),
  })
  const body: unknown = await res.json().catch(() => null)

  if (res.ok) {
    const id = (body as { id?: string }).id ?? ''
    return { name, verdict: 'OK', detail: `intent minted (${id.slice(0, 8)}…) — creds + enablement good` }
  }
  if (res.status === 404) {
    return {
      name,
      verdict: 'OK (no Link account)',
      detail:
        'Documented 404: probe email has no Link account. NOTE: Stripe’s error table also 404s an ' +
        'unrecognized OAuth client — to disambiguate, rerun with SMOKE_PROBE_EMAIL=<an email that ' +
        'has a Link account>; a 200 (intent minted) settles it.',
    }
  }
  return { name, ...classifyStatus(res.status, body) }
}

async function probeOnrampQuotes(): Promise<ProbeResult> {
  const name = 'Onramp quotes (api.stripe.com, beta header)'
  const params = new URLSearchParams({ ui_mode: 'headless', source_amount: '25.00', source_currency: 'usd' })
  params.append('destination_currencies[]', 'usdc')
  params.append('destination_networks[]', 'base')

  const res = await fetch(`${env.STRIPE_API_BASE}/v1/crypto/onramp_quotes?${params}`, {
    signal: AbortSignal.timeout(env.STRIPE_TIMEOUT_SECONDS * 1000),
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Stripe-Version': env.STRIPE_CRYPTO_VERSION,
    },
  })
  const body: unknown = await res.json().catch(() => null)

  if (res.ok) {
    const quotes = (body as { destination_network_quotes?: Record<string, unknown[]> })
      .destination_network_quotes
    const count = quotes ? Object.values(quotes).flat().length : 0
    return { name, verdict: 'OK', detail: `${count} quote(s) for $25 USDC-on-Base — crypto API provisioned` }
  }
  return { name, ...classifyStatus(res.status, body) }
}

async function main() {
  console.log('Stripe crypto onramp smoke — K3\n')
  console.log(`  api base:   ${env.STRIPE_API_BASE}`)
  console.log(`  link base:  ${env.LINK_OAUTH_API_BASE}`)
  console.log(`  version:    ${env.STRIPE_CRYPTO_VERSION}`)
  console.log(`  platform key: ${env.STRIPE_SECRET_KEY ? 'set' : 'MISSING'}`)
  console.log(`  oauth client: ${env.STRIPE_CRYPTO_OAUTH_CLIENT_ID ? 'set' : 'MISSING'}`)
  console.log(`  oauth secret: ${env.STRIPE_CRYPTO_OAUTH_CLIENT_SECRET ? 'set' : 'MISSING'}\n`)

  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_CRYPTO_OAUTH_CLIENT_ID) {
    console.log('Credentials missing — nothing to probe. Set them in Doppler/.env first.')
    process.exitCode = 1
    return
  }

  const results = [await probeLinkAuthIntent(), await probeOnrampQuotes()]

  console.log('Results:')
  for (const r of results) {
    console.log(`  ${r.verdict.startsWith('OK') ? '✓' : '✗'} ${r.name}: ${r.verdict}`)
    if (r.detail) console.log(`      ${r.detail}`)
  }
  console.log(
    '\nNot probed (needs a consented user token, K5): transaction_limits, customers, sessions.',
  )
  if (results.some((r) => !r.verdict.startsWith('OK'))) process.exitCode = 1
}

await main()
