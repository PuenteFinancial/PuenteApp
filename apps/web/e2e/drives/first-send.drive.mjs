// Live drive: automate a first send through the real UI against the Stripe
// and Bridge sandboxes. Real Chromium via Playwright — trusted input, so the
// payment element's iframes actually respond (the Browser pane can't).
//
// Two fixture users on staging, two paths:
//
//   K5 path (default) — the existing test user (already Link-authed + KYC
//   verified + Bridge approved): the pay step boots straight to `collect`.
//     doppler run -p puente-api -c stg_main -- node e2e/drives/first-send.drive.mjs [--checkout]
//
//   K6 path (--relay) — a SECOND fixture with no Bridge customer and no
//   Bridge ToS on file, so the whole relay leg runs: intro → ToS card →
//   Bridge's hosted click-through → Link OTP → KYC form (DOB + tax ID) →
//   Stripe verified → POST relay → Bridge poll → approved → `collect`.
//     doppler run -p puente-api -c stg_main -- node e2e/drives/first-send.drive.mjs --relay [--accept-tos] [--approve]
//     --accept-tos  click through Bridge's hosted terms page. That IS a terms
//                   acceptance on the sandbox account — ask before using it.
//                   Without it the drive stops AT the terms page and reports.
//     --approve     after the relay lands, POST simulate_kyc_approval on the
//                   sandbox customer (BRIDGE_API_KEY) and wait for the
//                   webhook → `collect`. Without it, stops at the Bridge poll.
//     --stop-after-tos  end right after the return leg records the consent —
//                   leaves the fixture at "ToS accepted, no customer".
//     --block-relay abort the relay POST from the browser (RELAY_ERROR 0 →
//                   retryable card) — leaves the fixture at "Stripe verified,
//                   no customer", so the NEXT run exercises relay_form(reload).
//     --reset-customer  before driving, null bridge_customer_id/kyc_status on
//                   the fixture's users row (service role). The customer stays
//                   at Bridge; a re-relay with the same values replays the
//                   per-user+body-hash Idempotency-Key and gets the same id.
//   Starting states this covers (run in order, each on a fresh browser):
//     fresh · ToS-only · verified-no-customer (reload form) · customer pending
//     · fully approved (also the K5 path). Rejection/Persona need a sandbox
//     rejection Bridge does not simulate — live pilot only.
//   Bridge's ToS page redirects to the ORIGIN the API honored (ALLOWED_ORIGINS
//   on the API config, so on a Doppler stg_main run that is the staging web
//   deploy, not localhost). The drive catches that redirect, lifts the
//   signed_agreement_id, and replays the return leg on the local app — the
//   same page, cookies, and API call a real return would hit.
//   The K6 fixture is created on first use through the GoTrue admin API and
//   seeded (profile, consents, one recipient + CLABE) through OUR API. Its
//   password is RESET to a fresh random value on every run and never printed
//   (the k5-reset recipe, automated) — nothing about it lands in a transcript.
//
// Without --checkout neither path ever charges a card: the checkout POST is
// intercepted, so the session create (the wallet-shape gate) still runs.
import { chromium } from 'playwright'
import { randomBytes, randomUUID } from 'node:crypto'

const WEB = 'http://localhost:3000'
const API = 'http://localhost:3001'
const RUN_CHECKOUT = process.argv.includes('--checkout')
const RELAY = process.argv.includes('--relay')
const ACCEPT_TOS = process.argv.includes('--accept-tos')
const APPROVE = process.argv.includes('--approve')
const STOP_AFTER_TOS = process.argv.includes('--stop-after-tos')
const BLOCK_RELAY = process.argv.includes('--block-relay')
const RESET_CUSTOMER = process.argv.includes('--reset-customer')

const url = process.env.SUPABASE_URL
const anon = process.env.SUPABASE_PUBLISHABLE_KEY
// The API's own name for the service key (Doppler stg_main) first; the
// Supabase CLI's name as a fallback for local runs.
const serviceRole = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY

// K5 fixture (pre-approved).
const K5_EMAIL = 'k5-drive-20260828@puentefinancial.com'
const K5_PASSWORD = process.env.K5_DRIVE_PASSWORD
const K5_DESTINATION = '2668dd54-86a2-4875-8792-adefbc8428bc'

// K6 fixture (relay path). Synthetic phone (555-01xx block is reserved for
// fiction); the ZZ-TEST name keeps it unmistakable in any list.
const K6_EMAIL = process.env.K6_DRIVE_EMAIL ?? 'k6-drive-20260903@puentefinancial.com'
const K6_PHONE = '+12025550193'

const SCREENSHOT_DIR =
  process.env.DRIVE_SCREENSHOT_DIR ??
  '/private/tmp/claude-501/-Users-joshuaphelps-Puente-PuenteApp/ad1dc3c5-bf1e-498e-b08a-c1bdf38018df/scratchpad'

// ── Auth + fixture plumbing ─────────────────────────────────────────────────

async function passwordGrant(email, password) {
  const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: anon },
    body: JSON.stringify({ email, password }),
  })
  const body = await res.json()
  if (!body.access_token) throw new Error('sign-in failed: ' + JSON.stringify(body).slice(0, 200))
  return body.access_token
}

const adminHeaders = () => ({
  'Content-Type': 'application/json',
  apikey: serviceRole,
  Authorization: `Bearer ${serviceRole}`,
})

/** Find the K6 fixture's auth id by email (public.users mirrors it via the
 *  signup trigger), or null. */
async function findUserIdByEmail(email) {
  const res = await fetch(`${url}/rest/v1/users?email=eq.${encodeURIComponent(email)}&select=id`, {
    headers: adminHeaders(),
  })
  if (!res.ok) throw new Error(`users lookup failed: ${res.status}`)
  const rows = await res.json()
  return rows[0]?.id ?? null
}

/** Ensure the K6 fixture exists and reset its password to a value that lives
 *  only in this process. Returns an access token. */
async function ensureK6Fixture() {
  if (!serviceRole) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required for --relay (fixture admin)')
  const password = randomBytes(24).toString('base64url')
  let id = await findUserIdByEmail(K6_EMAIL)
  if (!id) {
    const res = await fetch(`${url}/auth/v1/admin/users`, {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({
        email: K6_EMAIL,
        password,
        email_confirm: true,
        phone: K6_PHONE,
        phone_confirm: true,
      }),
    })
    const body = await res.json()
    if (!res.ok || !body.id) throw new Error('fixture create failed: ' + JSON.stringify(body).slice(0, 200))
    id = body.id
    console.log('k6 fixture created')
  } else {
    const res = await fetch(`${url}/auth/v1/admin/users/${id}`, {
      method: 'PUT',
      headers: adminHeaders(),
      body: JSON.stringify({ password }),
    })
    if (!res.ok) throw new Error(`fixture password reset failed: ${res.status}`)
    console.log('k6 fixture password reset (in-process only)')
  }
  const token = await passwordGrant(K6_EMAIL, password)

  if (RESET_CUSTOMER) {
    // Test-only state surgery on the synthetic row: forget the customer so
    // the relay leg runs again. Production never nulls this column.
    const res = await fetch(`${url}/rest/v1/users?id=eq.${id}`, {
      method: 'PATCH',
      headers: { ...adminHeaders(), Prefer: 'return=minimal' },
      body: JSON.stringify({ bridge_customer_id: null, kyc_status: 'not_started' }),
    })
    if (!res.ok) throw new Error(`reset-customer failed: ${res.status}`)
    console.log('k6 fixture: bridge_customer_id cleared (customer remains at Bridge)')
  }

  // Seed through OUR API so every row goes through the real validation.
  const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
  const me = await (await fetch(`${API}/v1/users/me`, { headers: H })).json()
  if (me.bridgeCustomerId) {
    console.log('  NOTE: k6 fixture already has a Bridge customer — the relay will no-op (200).')
  }
  if (me.bridgeTosAccepted) {
    console.log('  NOTE: k6 fixture already has bridge_tos on file — the ToS card is skipped.')
  }
  if (!me.profileComplete) {
    const res = await fetch(`${API}/v1/users/me`, {
      method: 'PATCH',
      headers: H,
      body: JSON.stringify({
        firstName: 'ZZ-TEST',
        lastName: 'K6-DRIVE-SYNTHETIC',
        email: K6_EMAIL,
        addressLine1: '1 Congress Ave',
        addressCity: 'Austin',
        addressState: 'TX',
        addressPostalCode: '78701',
      }),
    })
    if (!res.ok) throw new Error(`profile seed failed: ${res.status} ${(await res.text()).slice(0, 200)}`)
    console.log('  profile seeded')
  }
  if (!me.consentsCurrent) {
    // Versions mirror REQUIRED_CONSENTS in packages/shared; a stale version
    // 400s here, which is the right way to learn they moved.
    const res = await fetch(`${API}/v1/users/me/consents`, {
      method: 'POST',
      headers: { ...H, 'x-client-ip': '203.0.113.7' },
      body: JSON.stringify({
        locale: 'en',
        consents: [
          { type: 'esign', version: '2026-08-27' },
          { type: 'puente_tos', version: '2026-07-21' },
          { type: 'puente_privacy', version: '2026-07-21' },
        ],
      }),
    })
    if (!res.ok) throw new Error(`consents seed failed: ${res.status} ${(await res.text()).slice(0, 200)}`)
    console.log('  consents seeded')
  }
  return token
}

/** A syntactically valid CLABE (mod-10 over weights 3,7,1; products reduced
 *  mod 10 before summing — the algorithm Bridge validates with). */
function syntheticClabe() {
  const digits = '002010' + String(Math.floor(Math.random() * 1e11)).padStart(11, '0')
  let sum = 0
  for (let i = 0; i < 17; i++) sum += ((digits.charCodeAt(i) - 48) * [3, 7, 1][i % 3]) % 10
  return digits + String((10 - (sum % 10)) % 10)
}

/** The K6 fixture's payout destination: reuse the first active one, else
 *  create a recipient + CLABE through the API (registration with Bridge is
 *  deferred until the customer exists — #269). */
async function ensureK6Destination(token) {
  const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
  const list = await (await fetch(`${API}/v1/recipients`, { headers: H })).json()
  for (const r of list.data ?? []) {
    const d = await (await fetch(`${API}/v1/recipients/${r.id}/destinations`, { headers: H })).json()
    const active = (d.data ?? []).find((x) => x.status !== 'archived')
    if (active) return active.id
  }
  const rec = await fetch(`${API}/v1/recipients`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({ firstName: 'Maria', lastName: 'Prueba', relationship: 'family', country: 'MX' }),
  })
  const recipient = await rec.json()
  if (!rec.ok) throw new Error('recipient seed failed: ' + JSON.stringify(recipient).slice(0, 200))
  const dst = await fetch(`${API}/v1/recipients/${recipient.id}/destinations`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      method: 'bank_account',
      currency: 'MXN',
      details: { clabe: syntheticClabe() },
      label: 'Drive CLABE',
    }),
  })
  const destination = await dst.json()
  if (!dst.ok) throw new Error('destination seed failed: ' + JSON.stringify(destination).slice(0, 200))
  console.log('  recipient + destination seeded')
  return destination.id
}

// Transfer setup goes through the API (fast + already UI-proven); the drive's
// job is the PAY STEP.
async function createConfirmedTransfer(token, destinationId) {
  const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }

  // Reuse an abandoned attempt rather than fighting the uncleared-exposure
  // cap: a PENDING_PAYMENT draft is exactly what the pay step wants, and the
  // cap would refuse a second one anyway (correctly).
  const listRes = await fetch(`${API}/v1/transfers?limit=5`, { headers: H })
  if (listRes.ok) {
    const { data } = await listRes.json()
    const pending = (data ?? []).find((t) => t.state === 'PENDING_PAYMENT')
    if (pending) {
      console.log('reusing pending transfer')
      return pending.id
    }
  }

  const quoteRes = await fetch(`${API}/v1/quotes`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      payoutDestinationId: destinationId,
      totalAmount: { amountMinor: 500, currency: 'USD' },
    }),
  })
  const quote = await quoteRes.json()
  if (!quoteRes.ok) throw new Error('quote failed: ' + JSON.stringify(quote).slice(0, 300))

  const trRes = await fetch(`${API}/v1/transfers`, {
    method: 'POST',
    headers: { ...H, 'Idempotency-Key': randomUUID() },
    body: JSON.stringify({ quoteId: quote.id }),
  })
  const transfer = await trRes.json()
  if (!trRes.ok) throw new Error('transfer failed: ' + JSON.stringify(transfer).slice(0, 300))

  const confRes = await fetch(`${API}/v1/transfers/${transfer.id}/confirm`, {
    method: 'POST',
    headers: { ...H, 'Idempotency-Key': randomUUID(), 'x-client-ip': '203.0.113.7' },
    body: JSON.stringify({ disclosureId: transfer.disclosure.id, accepted: true }),
  })
  const confirmed = await confRes.json()
  if (!confRes.ok) throw new Error('confirm failed: ' + JSON.stringify(confirmed).slice(0, 300))

  return transfer.id
}

// ── Browser helpers ─────────────────────────────────────────────────────────

const stepText = async (page) =>
  (await page.locator('main').innerText()).replace(/\n+/g, ' | ').slice(-260)

/** Wait until the pay step shows one of the given phrases (EN copy). */
async function waitForStep(page, phrases, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const text = await page.locator('main').innerText().catch(() => '')
    for (const p of phrases) if (text.includes(p)) return p
    await page.waitForTimeout(1000)
  }
  return null
}

/** Link auth. A FRESH browser has no SDK session, so the OTP sheet appears
 *  even for a user our server already knows. Sandbox OTP is always 000000.
 *  The Link modal appears on Stripe's schedule, and a typed code does not
 *  always land on the first try (the boxes mount progressively). Type, then
 *  confirm the sheet actually went away; retry a few times. */
async function completeLinkOtp(page) {
  const findOtp = async () => {
    // Stripe's frames only: our own KYC form has numeric inputs (ZIP, DOB)
    // and once the sheet closes they would match — and receive the code.
    for (const f of page.frames()) {
      if (f === page.mainFrame()) continue
      const otp = f.locator('input[inputmode="numeric"], input[autocomplete="one-time-code"]').first()
      if (await otp.isVisible({ timeout: 400 }).catch(() => false)) return otp
    }
    return null
  }
  let otpSeen = false
  for (let attempt = 0; attempt < 6; attempt++) {
    let otp = null
    for (let i = 0; i < 12 && !otp; i++) {
      otp = await findOtp()
      if (!otp) await page.waitForTimeout(1000)
    }
    if (!otp) break
    otpSeen = true
    await otp.click()
    await page.keyboard.type('000000', { delay: 120 })
    console.log(`link OTP entered (attempt ${attempt + 1})`)
    await page.waitForTimeout(6000)
    if (!(await findOtp())) break // sheet dismissed → accepted
  }
  if (!otpSeen) console.log('no OTP sheet (SDK session already authenticated)')
}

/** The payment element lives in one of ~10 Stripe iframes (most are hidden
 *  controllers). Find the one that renders the method rows, fill the test
 *  card, submit from whichever sibling frame holds the button. */
async function fillAndSubmitCard(page) {
  let frame = null
  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue
    const hit = await f.getByText('Card', { exact: true }).first().isVisible().catch(() => false)
    if (hit) {
      frame = f
      console.log('  → payment frame:', (f.name() || f.url()).slice(0, 80))
      break
    }
  }
  if (!frame) throw new Error('payment element frame not found')

  await frame.getByText('Card', { exact: true }).first().click()
  console.log('selected: Card')
  await frame.getByPlaceholder('1234 1234 1234 1234').fill('4242424242424242')
  await frame.getByPlaceholder('MM / YY').fill('12 / 34')
  await frame.getByPlaceholder('CVC').fill('123')
  const zip = frame.getByPlaceholder('12345')
  if (await zip.isVisible({ timeout: 3000 }).catch(() => false)) await zip.fill('94080')
  console.log('card filled')

  for (const f of [frame, ...page.frames()]) {
    const btn = f.getByRole('button', { name: /submit|pay now|^pay$|continue/i }).first()
    if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
      await btn.click()
      console.log('submitted payment method via', (f.name() || 'main').slice(0, 40))
      return
    }
  }
  throw new Error('submit button not found in any frame')
}

/** Bridge's hosted terms page. Best effort — the page is theirs. */
async function clickThroughBridgeTos(page) {
  const box = page.getByRole('checkbox').first()
  if (await box.isVisible({ timeout: 5000 }).catch(() => false)) await box.check().catch(() => {})
  const btn = page.getByRole('button', { name: /accept|agree|continue|i agree/i }).first()
  await btn.waitFor({ state: 'visible', timeout: 15000 })
  await btn.click()
  console.log('bridge ToS: clicked through')
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  let token
  let destinationId
  if (RELAY) {
    token = await ensureK6Fixture()
    destinationId = await ensureK6Destination(token)
  } else {
    if (!K5_PASSWORD) throw new Error('K5_DRIVE_PASSWORD missing (Doppler stg_main)')
    token = await passwordGrant(K5_EMAIL, K5_PASSWORD)
    destinationId = K5_DESTINATION
  }
  const transferId = await createConfirmedTransfer(token, destinationId)
  console.log('transfer confirmed:', transferId)

  const browser = await chromium.launch({ headless: process.env.DRIVE_HEADED ? false : true })
  const context = await browser.newContext({ viewport: { width: 520, height: 1000 } })
  await context.addCookies([{ name: 'puente_session', value: token, domain: 'localhost', path: '/' }])
  // Language is per-browser (localStorage `puente_lang`, default es). Pin EN
  // before the first script runs so every selector below reads the same on
  // every run — the header toggle is not reachable on every page.
  await context.addInitScript(() => {
    try {
      localStorage.setItem('puente_lang', 'en')
    } catch {}
  })
  const page = await context.newPage()

  // Surface what the app tells our own API, and what it says in console.
  // Relay responses never echo the request (pinned server-side), so printing
  // a failure body here cannot leak the values the drive typed.
  page.on('console', (m) => {
    const t = m.text()
    if (t.includes('PostHog.js') || t.includes('HMR')) return
    console.log('  [console]', t.slice(0, 200))
  })
  page.on('response', async (res) => {
    const u = res.url()
    // Third-party failures (Stripe, Link, hCaptcha) — status + host/path only.
    if (!u.startsWith(WEB) && !res.ok() && res.status() !== 304) {
      const p = new URL(u)
      let detail = ''
      if (p.host === 'api.stripe.com' && res.status() < 500) {
        // Stripe's error envelope: code/param/message only (no request echo).
        const body = await res.json().catch(() => null)
        const e = body?.error
        if (e) detail = ` ← ${e.code ?? e.type ?? ''} ${e.param ?? ''} ${String(e.message ?? '').slice(0, 160)}`
      }
      console.log(`  [net] ${res.status()} ${p.host}${p.pathname.slice(0, 80)}${detail}`)
      return
    }
    if (!u.includes('/api/crypto/') && !u.includes('/api/transfers/') && !u.includes('/api/users/me/')) return
    const path = new URL(u).pathname
    let detail = ''
    if (!res.ok() || path.endsWith('/funding-session') || path.endsWith('/bridge-customer')) {
      const body = await res.text().catch(() => '')
      detail = ' ← ' + body.slice(0, 300)
    }
    console.log(`  [api] ${res.status()} ${path}${detail}`)
  })

  if (!RUN_CHECKOUT) {
    // Safety: stop before money moves. The session create still runs (that is
    // the wallet-shape gate); only the checkout call is blocked.
    await page.route('**/api/crypto/transfers/*/onramp-checkout', (route) =>
      route.fulfill({ status: 499, body: '{"error":{"code":"drive_stopped_here"}}' }),
    )
  }
  if (BLOCK_RELAY) {
    await page.route('**/api/users/me/bridge-customer', (route) => route.abort())
  }

  // Bridge's terms page redirects to whichever origin the API honored. Catch
  // the return URL at the request layer (an HTTP redirect chain never becomes
  // a committed navigation the URL matcher would see) and keep the id.
  let returnedAgreementId = null
  page.on('request', (req) => {
    const u = req.url()
    if (u.includes('/onboarding/kyc/tos-return') && u.includes('signed_agreement_id=')) {
      returnedAgreementId = new URL(u).searchParams.get('signed_agreement_id')
    }
  })

  const transferUrl = `${WEB}/dashboard/send/${transferId}`
  await page.goto(transferUrl)
  console.log('pay step loaded')

  await page.waitForTimeout(4000)
  console.log('  [early step]', await stepText(page))
  const cont = page.getByRole('button', { name: /^(Continue|Continuar)$/ })
  await cont.waitFor({ state: 'visible', timeout: 15000 })
  await cont.click()
  console.log('intro → continue')

  if (RELAY) {
    // ── ToS-first gate ──
    const tosBtn = page.getByRole('button', { name: /Review Bridge|términos de Bridge/ })
    if (await tosBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      console.log('bridge ToS card shown')
      await tosBtn.click()
      await page.waitForURL((u) => !u.toString().startsWith(WEB), { timeout: 20000 }).catch(() => {})
      const host = new URL(page.url()).host
      console.log('left for Bridge terms page:', host)
      if (!ACCEPT_TOS) {
        await page.screenshot({ path: `${SCREENSHOT_DIR}/drive-k6-tos.png`, fullPage: true })
        console.log('--- stopped at the Bridge terms page (pass --accept-tos to click through) ---')
        await browser.close()
        return
      }
      await clickThroughBridgeTos(page)
      // Either Bridge sent us straight home (localhost allowlisted) or it sent
      // us to the deployed origin — in which case replay the return leg here.
      const home = await page
        .waitForURL((u) => u.toString().startsWith(transferUrl), { timeout: 15000 })
        .then(() => true)
        .catch(() => false)
      if (!home) {
        for (let i = 0; i < 10 && !returnedAgreementId; i++) await page.waitForTimeout(1000)
        if (!returnedAgreementId) throw new Error('no tos-return redirect observed after Accept')
        console.log('bridge redirected to the deployed origin; replaying the return leg locally')
        await page.goto(`${WEB}/onboarding/kyc/tos-return?signed_agreement_id=${encodeURIComponent(returnedAgreementId)}`)
        await page.waitForURL((u) => u.toString().startsWith(transferUrl), { timeout: 30000 })
      }
      console.log('returned to the transfer (ToS recorded server-side)')
      const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
      const after = await (await fetch(`${API}/v1/users/me`, { headers: H })).json()
      console.log('  bridgeTosAccepted now:', after.bridgeTosAccepted)
      if (STOP_AFTER_TOS) {
        await page.screenshot({ path: `${SCREENSHOT_DIR}/drive-k6-after-tos.png`, fullPage: true })
        console.log('--- stopped after the ToS return (fixture: ToS accepted, no customer) ---')
        await browser.close()
        return
      }
      await page.waitForTimeout(3000)
      const again = page.getByRole('button', { name: /^(Continue|Continuar)$/ })
      await again.waitFor({ state: 'visible', timeout: 15000 })
      await again.click()
      console.log('intro → continue (post-ToS boot)')
    } else {
      console.log('no ToS card (bridge_tos already on file, or a customer exists)')
    }

    // ── Link auth → KYC form ──
    await completeLinkOtp(page)
    const landed = await waitForStep(page, ['Verify your identity', 'One more detail', 'Choose how to pay', 'Finishing verification'], 30000)
    console.log('  [after link]', landed ?? '(unrecognized)', '|', await stepText(page))

    if (landed === 'Verify your identity' || landed === 'One more detail') {
      // Sandbox canonical identity: Stripe verifies "John Verified" /
      // 000000000; Bridge's sandbox accepts the same. Name/address are
      // prefilled from the profile on the full form.
      await page.fill('#kyc-dob-m', '01')
      await page.fill('#kyc-dob-d', '15')
      await page.fill('#kyc-dob-y', '1990')
      await page.selectOption('#kyc-taxid-type', 'ssn')
      await page.fill('#kyc-taxid', '000000000')
      if (landed === 'Verify your identity') {
        await page.fill('#kyc-first', 'John')
        await page.fill('#kyc-last', 'Verified')
        // Stripe's sandbox verifies only its magic address; editing it here
        // also exercises the address sync-back (PATCH before the SDK submit).
        await page.fill('#kyc-line1', 'address_full_match')
      }
      await page.getByRole('button', { name: /Verify my identity|^Continue$/ }).click()
      console.log('identity form submitted')
    }

    // ── Stripe poll → relay → Bridge poll ──
    const post = await waitForStep(page, ['Finishing verification', 'Choose how to pay', 'One more detail', 'We need to check', 'couldn’t verify', 'Something went wrong'], 120000)
    console.log('  [after relay]', post ?? '(timeout)', '|', await stepText(page))
    if (BLOCK_RELAY) {
      await page.screenshot({ path: `${SCREENSHOT_DIR}/drive-k6-blocked-relay.png`, fullPage: true })
      console.log('--- relay blocked by the drive (fixture: Stripe verified, no customer) ---')
      await browser.close()
      return
    }
    if (post !== 'Finishing verification' && post !== 'Choose how to pay') {
      await page.screenshot({ path: `${SCREENSHOT_DIR}/drive-k6-relay.png`, fullPage: true })
      // What the form holds when it bounced (tax ID masked).
      const dump = await page.evaluate(() =>
        ['kyc-first', 'kyc-last', 'kyc-line1', 'kyc-city', 'kyc-state', 'kyc-zip', 'kyc-dob-m', 'kyc-dob-d', 'kyc-dob-y', 'kyc-taxid-type']
          .map((id) => `${id}=${document.getElementById(id)?.value ?? '(none)'}`)
          .join(' '),
      )
      console.log('  [form]', dump)
      throw new Error('relay did not reach the Bridge poll')
    }

    if (post === 'Finishing verification' && APPROVE) {
      const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
      const me = await (await fetch(`${API}/v1/users/me`, { headers: H })).json()
      if (!me.bridgeCustomerId) throw new Error('no bridgeCustomerId after relay')
      const base = process.env.BRIDGE_API_BASE ?? 'https://api.sandbox.bridge.xyz'
      const sim = await fetch(`${base}/v0/customers/${me.bridgeCustomerId}/simulate_kyc_approval`, {
        method: 'POST',
        headers: { 'Api-Key': process.env.BRIDGE_API_KEY, 'Content-Type': 'application/json' },
      })
      console.log('simulate_kyc_approval →', sim.status)
      const approved = await waitForStep(page, ['Choose how to pay', 'still in progress'], 150000)
      console.log('  [after approval]', approved ?? '(timeout)', '|', await stepText(page))
    }

    if (!(await page.getByText('Choose how to pay').isVisible().catch(() => false))) {
      await page.screenshot({ path: `${SCREENSHOT_DIR}/drive-k6-final.png`, fullPage: true })
      console.log('--- stopped before collect (pass --approve to simulate the Bridge approval) ---')
      await browser.close()
      return
    }
  } else {
    await completeLinkOtp(page)
    await page.waitForTimeout(12000)
  }

  // ── collect → session create (→ checkout with --checkout) ──
  await page.waitForTimeout(8000)
  console.log('  [step text]', await stepText(page))
  for (const f of page.frames()) {
    console.log('  [frame]', (f.name() || '-').slice(0, 40), '|', f.url().slice(0, 90))
  }
  await fillAndSubmitCard(page)

  // Let the session-create (and, with --checkout, performCheckout) play out.
  await page.waitForTimeout(25000)

  const text = await page.locator('main').innerText()
  console.log('--- final pay-step text ---')
  console.log(text.split('\n').filter(Boolean).slice(-8).join('\n'))

  await page.screenshot({ path: `${SCREENSHOT_DIR}/drive-final.png`, fullPage: true })
  await browser.close()
}

main().catch((err) => {
  console.error('DRIVE FAILED:', err.message)
  process.exit(1)
})
