// C5 — the first send on the Checkout Sessions rail, end to end, for real.
//
// Nothing has ever PAID on this rail. C1 built the processor, C2 the Payment
// Element, C3 the Bridge identity leg, C4 the send gate — and all four are
// tested against payloads we wrote. This drive is what turns that into
// evidence: a real Checkout Session, a real payment, a real webhook delivered
// by Stripe, a real ledger posting, and reconciliation's own verdict.
//
// It runs against STAGING, not localhost, and that is the whole point. Stripe
// delivers checkout.session.* to the endpoint registered on the account, which
// is the staging API — so the transfer row, the session, the webhook and the
// worker all have to be in the same world for the delivery to mean anything.
//
//   doppler run -p puente-api -c stg_main -- node e2e/drives/checkout-send.drive.mjs [flags]
//
//     --accept-tos   click through Bridge's hosted terms. That IS a terms
//                    acceptance on the sandbox account — ask before using it.
//                    Without it the drive stops AT the terms page and reports.
//     --approve      after the relay lands, POST simulate_kyc_approval on the
//                    sandbox customer. Without it, stops at the Bridge poll.
//     --pay          actually confirm the payment. Without it the drive stops
//                    with the Payment Element mounted and reports what a
//                    sender would be offered — no money moves.
//     --fresh        new fixture email (a brand-new sender, no Bridge customer
//                    and no ToS). Otherwise the standing C5 fixture is reused.
//
// CARD, not bank debit, deliberately. A card is the leg with NO async event:
// `completed` arrives already `paid` and clearing comes only on
// `payment_intent.succeeded`. That is precisely the path the money bug lived
// on (mapping completed→cleared posts nothing and lets the sweep kill a
// charged transfer), and the only reason parseEvent falls through to the
// parent. Proving the card leg proves the part most likely to be wrong.
//
// The fixture's password is reset to a fresh random value each run and never
// printed. DOB and tax ID are the sandbox's canonical values, typed into the
// real form — they are test data, but they still never get logged here.
import { chromium } from 'playwright'
import { randomBytes, randomUUID } from 'node:crypto'

// LOCAL WEB against the STAGING API, and the split is deliberate. The Vercel
// staging deployment sits behind Vercel Authentication, so a headless browser
// lands on Vercel's login page rather than the app (measured 2026-09-09) —
// turning that off is a deployment-security decision, not a drive's business.
// Nothing that matters is lost: the SESSION is created by the staging API, the
// webhook is delivered by Stripe to the staging endpoint (deliveries are
// account-wide, not per-origin), and the row lives in the staging DB. Only the
// Vercel-served bundle goes unexercised, which CI's next build and the pay
// e2e already cover.
const WEB = process.env.DRIVE_WEB ?? 'http://localhost:3000'
const API = process.env.DRIVE_API ?? 'https://puenteapi-staging.up.railway.app'
const ACCEPT_TOS = process.argv.includes('--accept-tos')
const APPROVE = process.argv.includes('--approve')
const PAY = process.argv.includes('--pay')
const FRESH = process.argv.includes('--fresh')
// Bank debit instead of card. The economically important rail (roughly 0.8%
// capped vs ~2.9% + 30c on a remittance whose whole margin is ~100bps) and a
// genuinely different event shape: `completed` arrives payment_status=unpaid
// with the PI still processing, and clearing comes later on
// `checkout.session.async_payment_succeeded` — never the card's
// `payment_intent.succeeded`. Verification is instant-only (Financial
// Connections), so this walks Stripe's test institution.
const ACH = process.argv.includes('--ach')

const url = process.env.SUPABASE_URL
const anon = process.env.SUPABASE_PUBLISHABLE_KEY
const serviceRole = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !anon || !serviceRole) throw new Error('SUPABASE_URL / PUBLISHABLE / SERVICE_ROLE required')

const EMAIL = FRESH
  ? `c5-checkout-${Date.now()}@puentefinancial.com`
  : (process.env.C5_DRIVE_EMAIL ?? 'c5-checkout-20260909@puentefinancial.com')
const PHONE = `+1202555${String(Math.floor(Math.random() * 9000) + 1000)}`
const WEB_HOST = new URL(WEB).hostname
// Bridge redirects its terms page to whichever origin the API allowlists
// (ALLOWED_ORIGINS = the Vercel deploy), never to localhost. The drive catches
// that redirect at the request layer — an HTTP redirect chain never becomes a
// committed navigation a URL matcher would see — and replays the return leg
// here, which hits the same page, cookies and API call a real return would.
let returnedAgreementId = null

const adminHeaders = () => ({
  'Content-Type': 'application/json',
  apikey: serviceRole,
  Authorization: `Bearer ${serviceRole}`,
})

async function passwordGrant(email, password) {
  const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: anon },
    body: JSON.stringify({ email, password }),
  })
  const body = await res.json()
  if (!res.ok || !body.access_token) throw new Error('password grant failed: ' + res.status)
  return body.access_token
}

async function findUserIdByEmail(email) {
  const res = await fetch(`${url}/auth/v1/admin/users?page=1&per_page=200`, { headers: adminHeaders() })
  if (!res.ok) return null
  const body = await res.json()
  return (body.users ?? []).find((u) => u.email === email)?.id ?? null
}

/** A sender with a complete profile and consents, and NOTHING at Bridge —
 *  the state C3's identity leg exists to move out of, and the state C4's gate
 *  had to stop refusing. */
async function ensureFixture() {
  const password = randomBytes(24).toString('base64url')
  let id = await findUserIdByEmail(EMAIL)
  if (!id) {
    const res = await fetch(`${url}/auth/v1/admin/users`, {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({
        email: EMAIL, password, email_confirm: true, phone: PHONE, phone_confirm: true,
      }),
    })
    const body = await res.json()
    if (!res.ok || !body.id) throw new Error('fixture create failed: ' + JSON.stringify(body).slice(0, 200))
    id = body.id
    console.log('fixture created')
  } else {
    const res = await fetch(`${url}/auth/v1/admin/users/${id}`, {
      method: 'PUT', headers: adminHeaders(), body: JSON.stringify({ password }),
    })
    if (!res.ok) throw new Error(`fixture password reset failed: ${res.status}`)
    console.log('fixture password reset (in-process only)')
  }
  const token = await passwordGrant(EMAIL, password)
  const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
  const me = await (await fetch(`${API}/v1/users/me`, { headers: H })).json()
  console.log(
    `  fixture state: kyc=${me.kycStatus} bridgeCustomer=${me.bridgeCustomerId ? 'yes' : 'no'} ` +
      `tos=${me.bridgeTosAccepted ? 'yes' : 'no'} profile=${me.profileComplete} consents=${me.consentsCurrent}`,
  )
  if (!me.profileComplete) {
    const res = await fetch(`${API}/v1/users/me`, {
      method: 'PATCH', headers: H,
      body: JSON.stringify({
        firstName: 'ZZ-TEST', lastName: 'C5-CHECKOUT-SYNTHETIC', email: EMAIL,
        addressLine1: '1 Congress Ave', addressCity: 'Austin', addressState: 'TX', addressPostalCode: '78701',
      }),
    })
    if (!res.ok) throw new Error(`profile seed failed: ${res.status} ${(await res.text()).slice(0, 200)}`)
    console.log('  profile seeded')
  }
  if (!me.consentsCurrent) {
    const res = await fetch(`${API}/v1/users/me/consents`, {
      method: 'POST', headers: { ...H, 'x-client-ip': '203.0.113.7' },
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
  return { token, me }
}

function syntheticClabe() {
  const digits = '002010' + String(Math.floor(Math.random() * 1e11)).padStart(11, '0')
  let sum = 0
  for (let i = 0; i < 17; i++) sum += ((digits.charCodeAt(i) - 48) * [3, 7, 1][i % 3]) % 10
  return digits + String((10 - (sum % 10)) % 10)
}

async function ensureDestination(token) {
  const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
  const list = await (await fetch(`${API}/v1/recipients`, { headers: H })).json()
  for (const r of list.data ?? []) {
    const d = await (await fetch(`${API}/v1/recipients/${r.id}/destinations`, { headers: H })).json()
    const active = (d.data ?? []).find((x) => x.status !== 'archived')
    if (active) return active.id
  }
  const rec = await fetch(`${API}/v1/recipients`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ firstName: 'Maria', lastName: 'Prueba', relationship: 'family', country: 'MX' }),
  })
  const recipient = await rec.json()
  if (!rec.ok) throw new Error('recipient seed failed: ' + JSON.stringify(recipient).slice(0, 200))
  const dst = await fetch(`${API}/v1/recipients/${recipient.id}/destinations`, {
    method: 'POST', headers: H,
    body: JSON.stringify({
      method: 'bank_account', currency: 'MXN',
      details: { clabe: syntheticClabe() }, label: 'C5 drive CLABE',
    }),
  })
  const destination = await dst.json()
  if (!dst.ok) throw new Error('destination seed failed: ' + JSON.stringify(destination).slice(0, 200))
  console.log('  recipient + destination seeded')
  return destination.id
}

/** THE C4 ASSERTION, made against the real staging API: a sender Bridge has
 *  never seen must get through transfer creation and confirm. Before C4 this
 *  was a 403 and the whole rail was unreachable. */
async function createConfirmedTransfer(token, destinationId) {
  const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
  const listRes = await fetch(`${API}/v1/transfers?limit=5`, { headers: H })
  if (listRes.ok) {
    const { data } = await listRes.json()
    const pending = (data ?? []).find((t) => t.state === 'PENDING_PAYMENT')
    if (pending) {
      console.log('reusing pending transfer', pending.id)
      return pending.id
    }
  }
  const quoteRes = await fetch(`${API}/v1/quotes`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ payoutDestinationId: destinationId, totalAmount: { amountMinor: 500, currency: 'USD' } }),
  })
  const quote = await quoteRes.json()
  if (!quoteRes.ok) throw new Error('quote failed: ' + JSON.stringify(quote).slice(0, 300))
  const trRes = await fetch(`${API}/v1/transfers`, {
    method: 'POST', headers: { ...H, 'Idempotency-Key': randomUUID() },
    body: JSON.stringify({ quoteId: quote.id }),
  })
  const transfer = await trRes.json()
  if (!trRes.ok) throw new Error('transfer failed: ' + JSON.stringify(transfer).slice(0, 300))
  const confRes = await fetch(`${API}/v1/transfers/${transfer.id}/confirm`, {
    method: 'POST', headers: { ...H, 'Idempotency-Key': randomUUID(), 'x-client-ip': '203.0.113.7' },
    body: JSON.stringify({ disclosureId: transfer.disclosure.id, accepted: true }),
  })
  const confirmed = await confRes.json()
  if (!confRes.ok) throw new Error('confirm failed: ' + JSON.stringify(confirmed).slice(0, 300))
  console.log('  confirm →', JSON.stringify(confirmed.funding ?? {}))
  return transfer.id
}

// ── Browser helpers ─────────────────────────────────────────────────────────

const pageText = async (page) => await page.locator('main').innerText().catch(() => '')
/** Tail slice, for LOGGING only. Branching on it silently skipped the identity
 *  form on the first run — the heading had already scrolled out of the last
 *  300 chars. Branch on pageText. */
const stepText = async (page) => (await pageText(page)).replace(/\n+/g, ' | ').slice(-300)

async function waitForStep(page, phrases, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const text = await page.locator('main').innerText().catch(() => '')
    for (const p of phrases) if (text.includes(p)) return p
    await page.waitForTimeout(1000)
  }
  return null
}

async function clickThroughBridgeTos(page) {
  const box = page.getByRole('checkbox').first()
  if (await box.isVisible({ timeout: 5000 }).catch(() => false)) await box.check().catch(() => {})
  const btn = page.getByRole('button', { name: /accept|agree|continue|i agree/i }).first()
  await btn.waitFor({ state: 'visible', timeout: 20000 })
  await btn.click()
  console.log('bridge ToS: clicked through')
}

/** Sandbox's canonical identity. Typed into the real form so the whole
 *  client → relay → Bridge path runs; never logged. */
async function fillIdentityForm(page) {
  // By id, not label: the labels are localized AND the tax-ID one changes with
  // the SSN/ITIN selector.
  await page.locator('#kyc-dob-m').fill('01')
  await page.locator('#kyc-dob-d').fill('01')
  await page.locator('#kyc-dob-y').fill('1990')
  await page.locator('#kyc-taxid').fill('000000000')
  console.log('identity form filled (values not logged)')
  await page.getByRole('button', { name: /^continue$/i }).first().click()
}

/** The Payment Element lives in one of ~10 Stripe iframes. Report what the
 *  sender is actually offered — the array on the session does not say. */
async function readOfferedMethods(page) {
  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue
    const hit = await f.getByText('Card', { exact: true }).first().isVisible().catch(() => false)
    if (hit) {
      const text = await f.locator('body').innerText().catch(() => '')
      return { frame: f, methods: text.replace(/\n+/g, ' / ').slice(0, 200) }
    }
  }
  return { frame: null, methods: null }
}

/** Every input Stripe is rendering, across every frame. Only meaningful AFTER
 *  a method is selected — the fields do not exist before that. */
async function dumpFields(page) {
  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue
    const inputs = f.locator('input, select')
    const n = await inputs.count().catch(() => 0)
    if (!n) continue
    const rows = []
    for (let i = 0; i < n; i++) {
      const el = inputs.nth(i)
      const [id, name, ph, type, val] = await Promise.all([
        el.getAttribute('id').catch(() => null),
        el.getAttribute('name').catch(() => null),
        el.getAttribute('placeholder').catch(() => null),
        el.getAttribute('type').catch(() => null),
        el.inputValue().catch(() => ''),
      ])
      rows.push(`${name ?? id ?? '?'}[${type ?? ''}]${ph ? ` ph="${ph}"` : ''}${val ? ' =set' : ''}`)
    }
    console.log(`  [frame ${(f.name() || 'anon').slice(0, 28)}] ${rows.join(' · ')}`)
  }
}

/** Bank debit via Financial Connections. Stripe's test mode exposes a "Test
 *  Institution" that connects without real credentials; the flow opens in a
 *  nested frame or a popup, so this handles both. Best effort by nature — the
 *  screens are Stripe's and they move. */
async function fillAndSubmitBank(page, frame) {
  await frame.getByText(/US bank account/i).first().click()
  console.log('selected: US bank account')
  await page.waitForTimeout(2500)

  // The two fields Stripe actually renders, learned from dumping the frame:
  // "First and last name" and "Search for your bank". The first --ach run
  // clicked buttons blindly and confirm refused with "Please provide your full
  // name."
  const name = frame.getByPlaceholder('First and last name').first()
  if (await name.isVisible({ timeout: 4000 }).catch(() => false)) {
    await name.fill('ZZ-TEST C5-CHECKOUT-SYNTHETIC')
    console.log('  bank: account holder name filled')
  }

  const search = frame.getByPlaceholder('Search for your bank').first()
  if (await search.isVisible({ timeout: 4000 }).catch(() => false)) {
    await search.click()
    // The sandbox institutions are named "Test (Non-OAuth)" / "Test (OAuth)"
    // (docs.stripe.com/financial-connections/testing) — NOT "Test Institution",
    // which is what the first attempts searched for and never matched. Non-OAuth
    // is the one that stays in the modal; OAuth opens a popup.
    await search.fill('Test')
    console.log('  bank: searching for a sandbox test institution')
    await page.waitForTimeout(3500)
    if (process.env.DRIVE_DUMP_FIELDS) {
      console.log('  --- frames after opening the bank search ---')
      for (const sf of page.frames()) {
        if (sf === page.mainFrame()) continue
        const t = (await sf.locator('body').innerText().catch(() => '')).replace(/\n+/g, ' | ').trim()
        if (t) console.log(`    [${(sf.name() || 'anon').slice(0, 26)}] ${t.slice(0, 300)}`)
      }
      for (const pp of page.context().pages()) {
        if (pp === page) continue
        const t = (await pp.locator('body').innerText().catch(() => '')).replace(/\n+/g, ' | ').trim()
        console.log(`    [POPUP ${new URL(pp.url()).host}] ${t.slice(0, 300)}`)
      }
    }
    let picked = false
    for (const label of [/Test \(Non-OAuth\)/i, /Bank \(Non-OAuth\)/i, /Test \(OAuth\)/i]) {
      for (const sf of [frame, ...page.frames()]) {
        const hit = sf.getByText(label).first()
        if (await hit.isVisible({ timeout: 1200 }).catch(() => false)) {
          await hit.click()
          console.log(`  bank: picked ${String(label)}`)
          picked = true
          break
        }
      }
      if (picked) break
    }
    if (!picked) {
      console.log('  bank: no sandbox institution matched — dumping what IS on screen')
      for (const sf of page.frames()) {
        if (sf === page.mainFrame()) continue
        const t = (await sf.locator('body').innerText().catch(() => '')).replace(/\n+/g, ' | ').trim()
        if (t) console.log(`    [${(sf.name() || 'anon').slice(0, 24)}] ${t.slice(0, 260)}`)
      }
    }
  }
  await page.waitForTimeout(3000)

  // Financial Connections then runs its own screens, in this frame, a nested
  // one, or a popup. Walk whatever "agree / continue / connect / done" it
  // offers until nothing is left. Best effort by nature: they are Stripe's
  // screens and they move.
  for (let step = 0; step < 10; step++) {
    let clicked = false
    const surfaces = [frame, ...page.frames(), ...page.context().pages().filter((p) => p !== page)]
    for (const sf of surfaces) {
      const next = sf
        .getByRole('button', { name: /agree and continue|^continue$|^connect|^done$|^next$|link account|allow/i })
        .first()
      if (await next.isVisible({ timeout: 800 }).catch(() => false)) {
        const label = (await next.innerText().catch(() => '')).trim().slice(0, 40)
        await next.click().catch(() => {})
        console.log(`  bank: "${label}"`)
        clicked = true
        await page.waitForTimeout(2500)
        break
      }
    }
    if (!clicked) break
  }
  await page.waitForTimeout(2000)
  console.log('  bank: connection flow finished')
}

async function fillAndSubmitCard(page, frame) {
  await frame.getByText('Card', { exact: true }).first().click()
  await frame.getByPlaceholder('1234 1234 1234 1234').fill('4242424242424242')
  await frame.getByPlaceholder('MM / YY').fill('12 / 34')
  await frame.getByPlaceholder('CVC').fill('123')
  const zip = frame.getByPlaceholder('12345')
  if (await zip.isVisible({ timeout: 3000 }).catch(() => false)) await zip.fill('94080')
  console.log('card filled (4242, test mode)')

  // Contact fields Stripe renders alongside the card. The first --pay run died
  // on "Your phone number is incomplete" — the session carries an email but no
  // phone, and something in this Element wants one. A real sender types it, so
  // the drive does too; what matters is WHICH fields are required, which the
  // dump records.
  if (process.env.DRIVE_DUMP_FIELDS) await dumpFields(page)
  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue
    const tel = f.locator('input[type="tel"], input[name*="phone" i], input[autocomplete*="tel" i]').first()
    if (await tel.isVisible({ timeout: 800 }).catch(() => false)) {
      await tel.fill('2025550147')
      console.log('  phone filled (Stripe rendered a phone field)')
      break
    }
  }

  const pay = page.getByRole('button', { name: /^pay \$/i }).first()
  await pay.waitFor({ state: 'visible', timeout: 10000 })
  await pay.click()
  console.log('PAY CLICKED')
}

/** What the SERVER thinks happened — the only verdict that counts. */
async function reportTransfer(token, transferId, label) {
  const H = { Authorization: `Bearer ${token}` }
  const t = await (await fetch(`${API}/v1/transfers/${transferId}`, { headers: H })).json()
  console.log(`  [${label}] state=${t.state} claimedAt=${t.paymentClaimedAt ?? '-'}`)
  return t
}

async function main() {
  console.log(`C5 drive — web=${WEB_HOST} api=${new URL(API).hostname}`)
  const { token } = await ensureFixture()
  const destinationId = await ensureDestination(token)
  const transferId = await createConfirmedTransfer(token, destinationId)
  console.log('transfer:', transferId)

  const browser = await chromium.launch({ headless: !process.env.DRIVE_HEADED })
  const context = await browser.newContext({ viewport: { width: 520, height: 1000 } })
  await context.addCookies([{ name: 'puente_session', value: token, domain: WEB_HOST, path: '/' }])
  await context.addInitScript(() => {
    try { localStorage.setItem('puente_lang', 'en') } catch {}
  })
  const page = await context.newPage()
  page.on('request', (req) => {
    const u = req.url()
    if (u.includes('/onboarding/kyc/tos-return') && u.includes('signed_agreement_id=')) {
      returnedAgreementId = new URL(u).searchParams.get('signed_agreement_id')
    }
  })
  page.on('console', (m) => {
    const t = m.text()
    if (t.includes('PostHog') || t.includes('HMR')) return
    console.log('  [console]', t.slice(0, 180))
  })

  await page.goto(`${WEB}/dashboard/send/${transferId}`, { waitUntil: 'domcontentloaded' })
  const first = await waitForStep(
    page,
    ['Before you verify', 'Verify your identity', 'Choose how to pay', 'could not load'],
    45000,
  )
  console.log('pay step opened on:', first ?? '(timeout)', '|', await stepText(page))

  if (first === 'Before you verify') {
    if (!ACCEPT_TOS) {
      console.log('\nSTOPPING at the Bridge terms (no --accept-tos).')
      await browser.close()
      return
    }
    await page.getByRole('button', { name: /review bridge/i }).first().click()
    await page.waitForURL((u) => !u.toString().startsWith(WEB), { timeout: 45000 })
    console.log('left for Bridge terms:', new URL(page.url()).host)
    await clickThroughBridgeTos(page)
    const transferUrl = `${WEB}/dashboard/send/${transferId}`
    const home = await page
      .waitForURL((u) => u.toString().startsWith(transferUrl), { timeout: 15000 })
      .then(() => true)
      .catch(() => false)
    if (!home) {
      for (let i = 0; i < 12 && !returnedAgreementId; i++) await page.waitForTimeout(1000)
      if (!returnedAgreementId) throw new Error('no tos-return redirect observed after Accept')
      console.log('bridge returned to the deployed origin; replaying the return leg locally')
      await page.goto(
        `${WEB}/onboarding/kyc/tos-return?signed_agreement_id=${encodeURIComponent(returnedAgreementId)}`,
      )
      await page.waitForURL((u) => u.toString().startsWith(transferUrl), { timeout: 30000 })
    }
    const H2 = { Authorization: `Bearer ${token}` }
    const after = await (await fetch(`${API}/v1/users/me`, { headers: H2 })).json()
    console.log('  bridgeTosAccepted now:', after.bridgeTosAccepted)
    const back = await waitForStep(page, ['Verify your identity', 'Choose how to pay'], 45000)
    console.log('after ToS return:', back ?? '(timeout)', '|', await stepText(page))
  }

  if ((await pageText(page)).includes('Verify your identity')) {
    await fillIdentityForm(page)
    const relayed = await waitForStep(
      page,
      ['Finishing verification', 'Verification is still in progress', 'Choose how to pay', 'One more verification'],
      60000,
    )
    console.log('after relay:', relayed ?? '(timeout)', '|', await stepText(page))
  }

  if (APPROVE) {
    const H = { Authorization: `Bearer ${token}` }
    // The relay POST is still in flight when the form submits — the machine is
    // showing "Finishing verification" while Bridge creates the customer. Poll
    // for the id rather than racing it.
    let me = null
    for (let i = 0; i < 30; i++) {
      me = await (await fetch(`${API}/v1/users/me`, { headers: H })).json()
      if (me.bridgeCustomerId) break
      await page.waitForTimeout(2000)
    }
    if (!me?.bridgeCustomerId) {
      console.log('  page says:', await stepText(page))
      throw new Error('no bridgeCustomerId after 60s of relay')
    }
    console.log('  bridge customer created; kyc =', me.kycStatus)
    const base = process.env.BRIDGE_API_BASE ?? 'https://api.sandbox.bridge.xyz'
    const sim = await fetch(`${base}/v0/customers/${me.bridgeCustomerId}/simulate_kyc_approval`, {
      method: 'POST',
      headers: { 'Api-Key': process.env.BRIDGE_API_KEY, 'Content-Type': 'application/json' },
    })
    console.log('simulate_kyc_approval →', sim.status)
    const approved = await waitForStep(page, ['Choose how to pay', 'still in progress'], 180000)
    console.log('after approval:', approved ?? '(timeout)', '|', await stepText(page))
  }

  if (!(await pageText(page)).includes('Choose how to pay')) {
    console.log('\nSTOPPING before payment — the pay form is not up.')
    await browser.close()
    return
  }

  await page.waitForTimeout(5000)
  const { frame, methods } = await readOfferedMethods(page)
  console.log('\nMETHODS THE SENDER IS ACTUALLY OFFERED:', methods ?? '(no payment frame)')
  if (!frame) throw new Error('payment element frame not found')

  if (!PAY) {
    console.log('\nSTOPPING with the Payment Element mounted (no --pay). No money moved.')
    await browser.close()
    return
  }

  if (ACH) {
    await fillAndSubmitBank(page, frame)
    if (process.env.DRIVE_DUMP_FIELDS) await dumpFields(page)
    const pay = page.getByRole('button', { name: /^pay \$/i }).first()
    await pay.waitFor({ state: 'visible', timeout: 10000 })
    await pay.click()
    console.log('PAY CLICKED (bank debit)')
  } else {
    await fillAndSubmitCard(page, frame)
  }
  const submitted = await waitForStep(page, ['Payment submitted', 'went wrong', "couldn't"], 60000)
  console.log('after confirm:', submitted ?? '(timeout)', '|', await stepText(page))

  // The webhook is the point. Poll the SERVER, not the page.
  console.log('\nwaiting for Stripe to deliver checkout.session.completed …')
  let funded = null
  for (let i = 0; i < 40; i++) {
    const t = await reportTransfer(token, transferId, `t+${i * 3}s`)
    if (t.state !== 'PENDING_PAYMENT') { funded = t; break }
    await page.waitForTimeout(3000)
  }
  console.log(funded ? `\nSTATE ADVANCED → ${funded.state}` : '\nSTILL PENDING_PAYMENT after 120s')
  await page.screenshot({ path: '/tmp/c5-after-pay.png', fullPage: true })
  await browser.close()
}

main().catch((e) => {
  console.error('DRIVE FAILED:', e?.message ?? e)
  process.exit(1)
})
