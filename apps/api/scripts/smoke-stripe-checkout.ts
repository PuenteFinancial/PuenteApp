// Smoke-test the Stripe Checkout Sessions credentials + account configuration
// (the Checkout Sessions rail — see docs/prds/checkout-sessions-rail.md).
//
// Sibling of smoke-stripe-crypto.ts, and deliberately a different shape,
// because the two rails fail differently. The crypto rail is a private preview
// whose whole risk is "are the account flags provisioned"; Checkout Sessions is
// generally available, so the interesting questions are instead:
//
//   1. Does this secret key work at all, in this mode?
//   2. Does `ui_mode: 'elements'` come back with a client_secret — i.e. can we
//      actually drive our own Payment Element off a session?
//   3. WHICH PAYMENT METHODS would a sender be offered? On this rail that is
//      Dashboard configuration rather than code (the Payment Intents rail
//      hard-codes `payment_method_types`), so it is invisible from the
//      repository and worth reading back from a real session.
//
// Question 3 is the one that would otherwise be found late and in the worst
// place: nothing in our source says whether ACH or debit is enabled on a given
// account, so a rail that works perfectly in staging can offer a live sender a
// payment sheet with the wrong methods on it.
//
// NOT read-only, unlike the crypto smoke — a Checkout Session is a real object.
// It is inert (no customer, no charge, nothing owed) and the script EXPIRES it
// immediately, so the account is left as it was found. An expired session
// cannot be paid.
//
// Usage:
//   doppler run -p puente-api -c stg_main -- pnpm exec tsx scripts/smoke-stripe-checkout.ts
//   doppler run -p puente-api -c prd_main -- pnpm exec tsx scripts/smoke-stripe-checkout.ts
//
// Optional: SMOKE_AMOUNT_MINOR (default 2500 = $25.00)

import { env } from '../src/config/env.js'

const AMOUNT_MINOR = Number(process.env.SMOKE_AMOUNT_MINOR ?? '2500')
// Never reached by anyone: the session is expired before this could be opened.
const RETURN_URL = `${env.PUBLIC_API_URL}/smoke/checkout-return?session_id={CHECKOUT_SESSION_ID}`

interface ProbeResult {
  name: string
  verdict: string
  detail?: string | undefined
}

interface SessionResponse {
  id?: string
  client_secret?: string
  ui_mode?: string
  status?: string
  payment_status?: string
  payment_method_types?: string[]
  error?: { message?: string; code?: string; type?: string }
}

function classify(
  status: number,
  body: SessionResponse,
): { verdict: string; detail?: string | undefined } {
  const message = body.error?.message ?? ''
  if (status === 401) {
    return {
      verdict: 'BAD SECRET KEY',
      detail:
        'STRIPE_SECRET_KEY rejected. Check it is the full sk_live_/sk_test_ value from the ' +
        'Secret key row — not the Restricted key, and not a truncated paste.',
    }
  }
  if (status === 403) {
    return { verdict: 'KEY VALID BUT NOT PERMITTED', detail: message || 'Restricted key?' }
  }
  if (message.includes('ui_mode')) {
    return {
      verdict: 'ui_mode=elements NOT AVAILABLE',
      detail: `${message} — the rail depends on this; escalate to Stripe before building.`,
    }
  }
  return { verdict: `HTTP ${status}`, detail: body.error?.code || message || undefined }
}

async function stripeForm(
  path: string,
  form: Record<string, string>,
): Promise<{ status: number; body: SessionResponse }> {
  const res = await fetch(`${env.STRIPE_API_BASE}${path}`, {
    method: 'POST',
    signal: AbortSignal.timeout(env.STRIPE_TIMEOUT_SECONDS * 1000),
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(form),
  })
  return { status: res.status, body: (await res.json()) as SessionResponse }
}

// The five events this rail needs. `completed` drives FUNDED; clearing then
// arrives on DIFFERENT events depending on how the sender paid — a bank debit
// clears on its async event, a card clears on payment_intent.succeeded and
// emits no async event ever. Miss the payment_intent pair and every
// card-funded transfer stays uncleared forever with its receivable open.
// See services/funding/stripe-checkout.ts.
const REQUIRED_EVENTS = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  // The loss path. A post-settlement ACH return or a card chargeback arrives
  // as a dispute, and on this rail Puente is merchant of record — it is OUR
  // money. Found unsubscribed on staging 2026-09-10 by paying with Stripe's
  // dispute test card: the dispute was created, the event fired, and it
  // reached nothing. Six events, not five.
  'charge.dispute.created',
] as const

interface WebhookEndpoint {
  url?: string
  status?: string
  enabled_events?: string[]
}

async function stripeGet(path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${env.STRIPE_API_BASE}${path}`, {
    signal: AbortSignal.timeout(env.STRIPE_TIMEOUT_SECONDS * 1000),
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
  })
  return { status: res.status, body: await res.json() }
}

/**
 * Are the rail's webhook events actually subscribed?
 *
 * Read-only, and worth a probe rather than a one-off check because it is
 * configuration living outside the repository that silently decides whether
 * money is recorded. A missing event does not error anywhere — Stripe simply
 * never calls us, the transfer sits in whatever state it was in, and the first
 * symptom is a reconciliation finding days later.
 *
 * Reports per endpoint and passes if ANY enabled endpoint carries all five,
 * since an account can legitimately have several.
 */
async function probeWebhookEvents(): Promise<ProbeResult> {
  const name = 'Webhook events subscribed'
  const { status, body } = await stripeGet('/v1/webhook_endpoints?limit=20')
  if (status !== 200) {
    return { name, verdict: `HTTP ${status}`, detail: 'Could not list webhook endpoints.' }
  }
  const endpoints = ((body as { data?: WebhookEndpoint[] }).data ?? []).filter(
    (e) => e.status === 'enabled',
  )
  if (endpoints.length === 0) {
    return {
      name,
      verdict: 'NO ENABLED ENDPOINTS',
      detail: 'Nothing will ever tell us a payment happened.',
    }
  }

  const lines: string[] = []
  let anyComplete = false
  for (const ep of endpoints) {
    const events = ep.enabled_events ?? []
    const all = events.includes('*')
    const missing = REQUIRED_EVENTS.filter((e) => !all && !events.includes(e))
    if (missing.length === 0) anyComplete = true
    lines.push(
      missing.length === 0
        ? `${ep.url} — all ${REQUIRED_EVENTS.length} present`
        : `${ep.url} — MISSING: ${missing.join(', ')}`,
    )
  }
  return {
    name,
    verdict: anyComplete ? 'OK' : 'INCOMPLETE',
    detail: lines.join('\n      '),
  }
}

let createdSessionId: string | undefined

async function probeCreateSession(): Promise<ProbeResult> {
  const name = 'Checkout Session create (ui_mode=elements)'
  // The exact shape the rail will use: one ad-hoc line item, no Product object,
  // amount in minor units, our own page as the return.
  const { status, body } = await stripeForm('/v1/checkout/sessions', {
    ui_mode: 'elements',
    mode: 'payment',
    return_url: RETURN_URL,
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': String(AMOUNT_MINOR),
    'line_items[0][price_data][product_data][name]': 'Puente smoke probe — not a real transfer',
    'metadata[smoke]': 'true',
  })

  if (status !== 200) return { name, ...classify(status, body) }
  createdSessionId = body.id

  if (!body.client_secret) {
    return {
      name,
      verdict: 'NO CLIENT SECRET',
      detail: 'Session created but returned no client_secret — the Payment Element cannot mount.',
    }
  }
  if (body.ui_mode !== 'elements') {
    return { name, verdict: 'WRONG ui_mode', detail: `Stripe returned ui_mode=${body.ui_mode}` }
  }
  return {
    name,
    verdict: 'OK',
    detail: `client_secret returned · status=${body.status} · payment_status=${body.payment_status}`,
  }
}

function reportPaymentMethods(methods: string[] | undefined): ProbeResult {
  const name = 'Payment methods offered (Dashboard configuration)'
  if (!methods?.length) {
    return {
      name,
      verdict: 'NONE REPORTED',
      detail: 'Session carried no payment_method_types — check the Dashboard payment methods.',
    }
  }
  // Not a pass/fail: what SHOULD be enabled is a product decision, not something
  // this script gets to assert. It reports, and names the two that matter for a
  // remittance so a missing one is obvious rather than merely absent.
  const has = (m: string) => (methods.includes(m) ? 'yes' : 'NO')
  return {
    name,
    verdict: `OK (${methods.length})`,
    detail: `${methods.join(', ')}  —  card: ${has('card')} · us_bank_account (ACH): ${has('us_bank_account')}`,
  }
}

async function expireSession(id: string): Promise<ProbeResult> {
  const name = 'Cleanup — expire the probe session'
  const { status, body } = await stripeForm(`/v1/checkout/sessions/${id}/expire`, {})
  if (status !== 200) {
    return {
      name,
      verdict: `HTTP ${status}`,
      detail: `Probe session ${id} is still open. It is unpaid and inert, and expires on its own, but you can expire it in the Dashboard. ${body.error?.message ?? ''}`.trim(),
    }
  }
  return { name, verdict: 'OK', detail: `session ${id} expired — account left as found` }
}

async function main(): Promise<void> {
  console.log('Stripe Checkout Sessions smoke\n')
  console.log(`  api base:     ${env.STRIPE_API_BASE}`)
  console.log(`  secret key:   ${env.STRIPE_SECRET_KEY ? 'set' : 'MISSING'}`)
  console.log(`  publishable:  ${env.STRIPE_PUBLISHABLE_KEY ? 'set' : 'MISSING'}`)
  console.log(`  webhook sec:  ${env.STRIPE_WEBHOOK_SECRET ? 'set' : 'MISSING'}`)
  console.log(`  probe amount: ${(AMOUNT_MINOR / 100).toFixed(2)} USD\n`)

  if (!env.STRIPE_SECRET_KEY) {
    console.log('STRIPE_SECRET_KEY missing — nothing to probe. Set it in Doppler first.')
    process.exitCode = 1
    return
  }

  const results: ProbeResult[] = []
  const created = await probeCreateSession()
  results.push(created)

  if (created.verdict === 'OK') {
    // Re-read the session so payment methods come from Stripe's own view of the
    // account rather than from what we asked for — we deliberately send no
    // payment_method_types, which is the point of this rail.
    const { body } = await stripeForm(`/v1/checkout/sessions/${createdSessionId}`, {})
    results.push(reportPaymentMethods(body.payment_method_types))
  }
  if (createdSessionId) results.push(await expireSession(createdSessionId))
  results.push(await probeWebhookEvents())

  console.log('Results:')
  for (const r of results) {
    console.log(`  ${r.verdict.startsWith('OK') ? '✓' : '✗'} ${r.name}: ${r.verdict}`)
    if (r.detail) console.log(`      ${r.detail}`)
  }
  console.log(
    '\nNot probed: actual webhook DELIVERY (needs a real payment) and confirmation (needs the\n' +
      'browser SDK). This proves the key, ui_mode=elements, the payment methods a sender would\n' +
      'be shown, and that the events which record the money are subscribed.',
  )
  if (results.some((r) => !r.verdict.startsWith('OK'))) process.exitCode = 1
}

await main()
