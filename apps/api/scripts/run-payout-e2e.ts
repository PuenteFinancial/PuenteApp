// Slice-5 sandbox end-to-end checklist (operator-run, NOT part of `pnpm test`).
// Drives one transfer through the full payout lifecycle against a RUNNING
// stack (API + worker + Bridge sandbox) and asserts each transition:
//
//   quote → transfer → confirm → funding webhook (PENDING_PAYMENT → FUNDED)
//   → worker submits (poll until SUBMITTED) → Bridge events / poller
//   (IN_FLIGHT → COMPLETED) → assert COMPLETED + event-dedupe on re-fire.
//
// Numbered steps, each asserted with PASS/FAIL logging; exits non-zero on the
// first failure. Lives in scripts/ with a top-level run guard so vitest never
// imports it.
//
// Required env:
//   API_BASE                     API base URL (default http://localhost:3001)
//   E2E_AUTH_TOKEN               Bearer JWT for an APPROVED user
//   E2E_PAYOUT_DESTINATION_ID    active payout_destination (active recipient,
//                                provider_account_ref set) owned by that user
//   MOCK_FUNDING_WEBHOOK_SECRET  HMAC secret for the mock funding webhook
// Optional env:
//   E2E_SEND_AMOUNT_MINOR        USD total amount, minor units (default 5000 = $50)
//   BRIDGE_WEBHOOK_PRIVATE_KEY   if set, fire Bridge webhooks to drive
//                                IN_FLIGHT→COMPLETED (else rely on payout.poll)
//   E2E_POLL_TIMEOUT_SECONDS     per-state poll budget (default 120)
//   E2E_POLL_INTERVAL_SECONDS    poll interval (default 3)
//
// Example:
//   API_BASE=http://localhost:3001 \
//   E2E_AUTH_TOKEN="$TOKEN" \
//   E2E_PAYOUT_DESTINATION_ID="$DEST" \
//   MOCK_FUNDING_WEBHOOK_SECRET="$SECRET" \
//     pnpm exec tsx scripts/run-payout-e2e.ts
import crypto from 'node:crypto'

const API_BASE = process.env.API_BASE ?? 'http://localhost:3001'
const AUTH_TOKEN = process.env.E2E_AUTH_TOKEN
const PAYOUT_DESTINATION_ID = process.env.E2E_PAYOUT_DESTINATION_ID
const FUNDING_SECRET = process.env.MOCK_FUNDING_WEBHOOK_SECRET
const SEND_AMOUNT_MINOR = Number(process.env.E2E_SEND_AMOUNT_MINOR ?? '5000')
const BRIDGE_PRIVATE_KEY = process.env.BRIDGE_WEBHOOK_PRIVATE_KEY
const POLL_TIMEOUT_MS = Number(process.env.E2E_POLL_TIMEOUT_SECONDS ?? '120') * 1000
const POLL_INTERVAL_MS = Number(process.env.E2E_POLL_INTERVAL_SECONDS ?? '3') * 1000

let step = 0
function pass(msg: string): void {
  console.log(`✓ PASS [${step}] ${msg}`)
}
function fail(msg: string): never {
  console.error(`✗ FAIL [${step}] ${msg}`)
  process.exit(1)
}
function begin(label: string): void {
  step++
  console.log(`\n── step ${step}: ${label}`)
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface JsonResponse {
  status: number
  body: Record<string, unknown>
  text: string
}

async function api(
  method: string,
  path: string,
  body?: unknown,
  auth = true,
): Promise<JsonResponse> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (auth) headers.Authorization = `Bearer ${AUTH_TOKEN}`
  // Fresh idempotency key per call — retries are the caller's job, not ours.
  headers['Idempotency-Key'] = crypto.randomUUID()
  // exactOptionalPropertyTypes: only set `body` when we actually have one.
  const init: RequestInit = { method, headers }
  if (body !== undefined) init.body = JSON.stringify(body)
  const res = await fetch(`${API_BASE}${path}`, init)
  const text = await res.text()
  let parsed: Record<string, unknown> = {}
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {}
  } catch {
    // leave parsed empty; caller asserts on status/text
  }
  return { status: res.status, body: parsed, text }
}

// Mirrors scripts/fire-funding-webhook.ts signing (HMAC-SHA256 over "{t}.{body}").
async function fireFundingWebhook(transferId: string): Promise<JsonResponse> {
  const payload = JSON.stringify({
    id: `evt_${crypto.randomUUID()}`,
    type: 'funding_succeeded',
    data: { transfer_id: transferId, payment_ref: `mockpay_${crypto.randomUUID()}` },
  })
  const t = Date.now()
  const sig = crypto.createHmac('sha256', FUNDING_SECRET as string).update(`${t}.${payload}`).digest('hex')
  const res = await fetch(`${API_BASE}/v1/webhooks/funding`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Funding-Signature': `t=${t},v1=${sig}` },
    body: payload,
  })
  return { status: res.status, body: {}, text: await res.text() }
}

// Mirrors scripts/fire-bridge-webhook.ts signing (RSA-SHA256 over the sha256
// digest of "{t}." + rawBody). Resolves on client_reference_id, so a synthetic
// bridge transfer id is fine when we only need to prove dedupe.
async function fireBridgeWebhook(
  clientReferenceId: string,
  bridgeTransferId: string,
  state: string,
): Promise<JsonResponse> {
  const privateKey = crypto.createPrivateKey((BRIDGE_PRIVATE_KEY as string).replace(/\\n/g, '\n'))
  const body = JSON.stringify({
    event_type: 'transfer.updated.status_transitioned',
    event_object_id: bridgeTransferId,
    event_object: { id: bridgeTransferId, state, status: state, client_reference_id: clientReferenceId },
  })
  const rawBody = Buffer.from(body, 'utf8')
  const t = Date.now()
  const digest = crypto.createHash('sha256').update(`${t}.`).update(rawBody).digest()
  const v0 = crypto.createSign('RSA-SHA256').update(digest).sign(privateKey, 'base64')
  const res = await fetch(`${API_BASE}/v1/webhooks/bridge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-webhook-signature': `t=${t},v0=${v0}` },
    body: rawBody,
  })
  return { status: res.status, body: {}, text: await res.text() }
}

async function getTransfer(id: string): Promise<Record<string, unknown>> {
  const res = await api('GET', `/v1/transfers/${id}`)
  if (res.status !== 200) fail(`GET /v1/transfers/${id} → ${res.status} ${res.text}`)
  return res.body
}

// Poll GET /v1/transfers/:id until it reaches one of `targets`. Fails the run
// if a terminal failure state is hit, or the timeout elapses.
async function pollUntilState(
  id: string,
  targets: string[],
  failStates: string[] = ['PAYMENT_FAILED', 'PAYOUT_FAILED'],
): Promise<string> {
  const deadline = Date.now() + POLL_TIMEOUT_MS
  let last = ''
  while (Date.now() < deadline) {
    const transfer = await getTransfer(id)
    const state = String(transfer.state)
    if (state !== last) {
      console.log(`   state: ${state}`)
      last = state
    }
    if (targets.includes(state)) return state
    if (failStates.includes(state)) fail(`transfer reached failure state ${state}`)
    await sleep(POLL_INTERVAL_MS)
  }
  return fail(`timed out after ${POLL_TIMEOUT_MS / 1000}s waiting for ${targets.join('|')} (last: ${last})`)
}

async function main(): Promise<void> {
  if (!AUTH_TOKEN || !PAYOUT_DESTINATION_ID || !FUNDING_SECRET) {
    fail(
      'missing env — require E2E_AUTH_TOKEN, E2E_PAYOUT_DESTINATION_ID, MOCK_FUNDING_WEBHOOK_SECRET',
    )
  }
  console.log(`payout e2e against ${API_BASE}`)
  console.log(
    BRIDGE_PRIVATE_KEY
      ? 'bridge webhooks: ENABLED (BRIDGE_WEBHOOK_PRIVATE_KEY set)'
      : 'bridge webhooks: DISABLED — relying on the payout.poll cron for COMPLETED',
  )

  // 1. Create quote
  begin('create quote')
  const quoteRes = await api('POST', '/v1/quotes', {
    payoutDestinationId: PAYOUT_DESTINATION_ID,
    totalAmount: { amountMinor: SEND_AMOUNT_MINOR, currency: 'USD' },
  })
  if (quoteRes.status !== 201) fail(`quote create → ${quoteRes.status} ${quoteRes.text}`)
  const quoteId = String(quoteRes.body.id)
  if (!quoteId || quoteId === 'undefined') fail('quote response missing id')
  pass(`quote ${quoteId} created`)

  // 2. Create transfer from quote
  begin('create transfer')
  const transferRes = await api('POST', '/v1/transfers', { quoteId })
  if (transferRes.status !== 201) fail(`transfer create → ${transferRes.status} ${transferRes.text}`)
  const transferId = String(transferRes.body.id)
  const disclosure = transferRes.body.disclosure as { id?: string } | undefined
  const disclosureId = disclosure?.id
  if (!transferId || transferId === 'undefined') fail('transfer response missing id')
  if (!disclosureId) fail('transfer response missing disclosure.id')
  if (transferRes.body.state !== 'PENDING_PAYMENT') {
    fail(`expected state PENDING_PAYMENT, got ${String(transferRes.body.state)}`)
  }
  pass(`transfer ${transferId} created (PENDING_PAYMENT, disclosure ${disclosureId})`)

  // 3. Confirm transfer (accept disclosure → funding instructions)
  begin('confirm transfer')
  const confirmRes = await api('POST', `/v1/transfers/${transferId}/confirm`, {
    disclosureId,
    accepted: true,
  })
  if (confirmRes.status !== 200) fail(`confirm → ${confirmRes.status} ${confirmRes.text}`)
  pass('transfer confirmed, funding initiated')

  // 4. Fire funding webhook → PENDING_PAYMENT → FUNDED
  begin('fire funding webhook (→ FUNDED)')
  const fundingRes = await fireFundingWebhook(transferId)
  if (fundingRes.status < 200 || fundingRes.status >= 300) {
    fail(`funding webhook → ${fundingRes.status} ${fundingRes.text}`)
  }
  pass('funding webhook accepted')

  // 5. Worker submits payout → poll until SUBMITTED
  begin('wait for worker to submit (→ SUBMITTED)')
  const submittedState = await pollUntilState(transferId, ['SUBMITTED', 'IN_FLIGHT', 'COMPLETED'])
  pass(`reached ${submittedState} (worker claimed + submitted to Bridge)`)

  // 6. Optionally fire Bridge webhooks, then wait for COMPLETED
  begin('drive to COMPLETED')
  // Reused by the dedupe step (8): re-firing the SAME id+state is what exercises
  // the (source, external_event_id) dedupe rather than inserting a fresh row.
  const bridgeTransferId = `sandbox_${crypto.randomUUID()}`
  if (BRIDGE_PRIVATE_KEY) {
    for (const st of ['payment_submitted', 'payment_processed']) {
      const r = await fireBridgeWebhook(transferId, bridgeTransferId, st)
      if (r.status < 200 || r.status >= 300) fail(`bridge webhook ${st} → ${r.status} ${r.text}`)
      console.log(`   fired bridge ${st} → ${r.status}`)
    }
  }
  const finalState = await pollUntilState(transferId, ['COMPLETED'])
  if (finalState !== 'COMPLETED') fail(`expected COMPLETED, got ${finalState}`)
  pass('transfer COMPLETED')

  // 7. Assertions on the completed transfer
  begin('assert completed transfer')
  const completed = await getTransfer(transferId)
  if (completed.state !== 'COMPLETED') fail(`state regressed to ${String(completed.state)}`)
  if (!completed.completedAt) fail('completedAt not set on COMPLETED transfer')
  // provider_transfer_ref may not be exposed by the GET response; assert only
  // when the API surfaces it (integrator may add it), else note it's unchecked.
  const providerRef =
    (completed.providerTransferRef as string | undefined) ??
    (completed.provider_transfer_ref as string | undefined)
  if (providerRef === undefined) {
    console.log('   note: provider_transfer_ref not exposed by GET — skipping that assertion')
  } else if (!providerRef) {
    fail('provider_transfer_ref is empty on COMPLETED transfer')
  } else {
    console.log(`   provider_transfer_ref = ${providerRef}`)
  }
  pass('completed transfer looks correct')

  // 8. Dedupe: re-fire the SAME event (same bridge id + state) — recordEvent
  // must dedupe on (source, external_event_id) and the state must not change.
  begin('event dedupe (re-fire same event, expect no state change)')
  if (BRIDGE_PRIVATE_KEY) {
    const before = String((await getTransfer(transferId)).state)
    const r = await fireBridgeWebhook(transferId, bridgeTransferId, 'payment_processed')
    if (r.status < 200 || r.status >= 300) fail(`re-fire → ${r.status} ${r.text}`)
    // Give the worker a moment to process the (idempotent) replay.
    await sleep(POLL_INTERVAL_MS * 2)
    const after = String((await getTransfer(transferId)).state)
    if (after !== before) fail(`state changed on replay: ${before} → ${after}`)
    pass(`re-fired payment_processed, state held at ${after} (idempotent)`)
  } else {
    console.log('   skipped — BRIDGE_WEBHOOK_PRIVATE_KEY not set (poller-only run)')
    pass('dedupe step skipped (no manual events fired)')
  }

  console.log('\n✅ payout e2e passed')
  process.exit(0)
}

main().catch((err: unknown) => {
  console.error(`✗ FAIL [${step}] uncaught: ${err instanceof Error ? err.stack : String(err)}`)
  process.exit(1)
})
