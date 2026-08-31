// K5 live drive: automate one full first-send through the real UI against the
// Stripe sandbox. Real Chromium via Playwright — trusted input, so the
// payment element's iframes actually respond (the Browser pane can't).
//
// Reuses the existing test user (already Link-authed + KYC verified + bridge
// approved), so the pay step boots straight to `collect`.
//
// Usage: doppler run -c stg_main -- node drive-send.mjs [--checkout]
//   without --checkout: stops after the onramp-session create (the
//   wallet-shape gate) and never charges the card.
import { chromium } from 'playwright'

const WEB = 'http://localhost:3000'
const API = 'http://localhost:3001'
const RUN_CHECKOUT = process.argv.includes('--checkout')

const url = process.env.SUPABASE_URL
const anon = process.env.SUPABASE_PUBLISHABLE_KEY
const EMAIL = 'k5-drive-20260828@puentefinancial.com'
const PASSWORD = process.env.K5_DRIVE_PASSWORD
const RECIPIENT = 'a115078a-f4b1-4ad8-a387-9f5f4ab617fc'
const DESTINATION = '2668dd54-86a2-4875-8792-adefbc8428bc'

async function mintToken() {
  const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: anon },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  })
  const body = await res.json()
  if (!body.access_token) throw new Error('sign-in failed: ' + JSON.stringify(body).slice(0, 200))
  return body.access_token
}

// Transfer setup goes through the API (fast + already UI-proven); the drive's
// job is the PAY STEP.
async function createConfirmedTransfer(token) {
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
      payoutDestinationId: DESTINATION,
      totalAmount: { amountMinor: 500, currency: 'USD' },
    }),
  })
  const quote = await quoteRes.json()
  if (!quoteRes.ok) throw new Error('quote failed: ' + JSON.stringify(quote).slice(0, 300))

  const trRes = await fetch(`${API}/v1/transfers`, {
    method: 'POST',
    headers: { ...H, 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify({ quoteId: quote.id }),
  })
  const transfer = await trRes.json()
  if (!trRes.ok) throw new Error('transfer failed: ' + JSON.stringify(transfer).slice(0, 300))

  const confRes = await fetch(`${API}/v1/transfers/${transfer.id}/confirm`, {
    method: 'POST',
    headers: { ...H, 'Idempotency-Key': crypto.randomUUID(), 'x-client-ip': '203.0.113.7' },
    body: JSON.stringify({ disclosureId: transfer.disclosure.id, accepted: true }),
  })
  const confirmed = await confRes.json()
  if (!confRes.ok) throw new Error('confirm failed: ' + JSON.stringify(confirmed).slice(0, 300))

  return transfer.id
}

async function main() {
  const token = await mintToken()
  const transferId = await createConfirmedTransfer(token)
  console.log('transfer confirmed:', transferId)

  const browser = await chromium.launch({ headless: process.env.DRIVE_HEADED ? false : true })
  const context = await browser.newContext({ viewport: { width: 520, height: 1000 } })
  await context.addCookies([
    { name: 'puente_session', value: token, domain: 'localhost', path: '/' },
  ])
  const page = await context.newPage()

  // Surface what the app tells our own API, and what it says in console.
  page.on('console', (m) => {
    const t = m.text()
    if (t.includes('PostHog.js') || t.includes('HMR')) return
    console.log('  [console]', t.slice(0, 200))
  })
  page.on('response', async (res) => {
    const u = res.url()
    if (!u.includes('/api/crypto/') && !u.includes('/api/transfers/')) return
    const path = new URL(u).pathname
    let detail = ''
    if (!res.ok() || path.endsWith('/funding-session')) {
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

  await page.goto(`${WEB}/dashboard/send/${transferId}`)
  console.log('pay step loaded')

  // Language is per-browser (localStorage, default es) — pin EN so the
  // selectors below read the same on every run.
  const en = page.getByRole('button', { name: 'EN' })
  if (await en.isVisible({ timeout: 5000 }).catch(() => false)) await en.click()

  await page.waitForTimeout(4000)
  console.log('  [early step]', (await page.locator('main').innerText()).replace(/\n+/g, ' | ').slice(-200))
  const cont = page.getByRole('button', { name: /^(Continue|Continuar)$/ })
  await cont.waitFor({ state: 'visible', timeout: 15000 })
  await cont.click()
  console.log('intro → continue')

  // Link auth. A FRESH browser has no SDK session, so the OTP sheet appears
  // even for a user our server already knows — that asymmetry is exactly what
  // the boot-routing fix accounts for. Sandbox OTP is always 000000.
  // The Link modal appears on Stripe's schedule, and a typed code does not
  // always land on the first try (the boxes mount progressively). Type, then
  // confirm the sheet actually went away; retry a few times before giving up.
  const findOtp = async () => {
    for (const f of page.frames()) {
      const otp = f
        .locator('input[inputmode="numeric"], input[autocomplete="one-time-code"]')
        .first()
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
  await page.waitForTimeout(12000)

  // The payment element lives in one of ~10 Stripe iframes (most are hidden
  // controllers). Find the one that actually renders the method rows —
  // Playwright drives it with TRUSTED input, which is the whole reason this
  // harness exists.
  await page.waitForTimeout(8000)
  console.log('  [step text]', (await page.locator('main').innerText()).replace(/\n+/g, ' | ').slice(-260))
  for (const f of page.frames()) {
    console.log('  [frame]', (f.name() || '-').slice(0, 40), '|', f.url().slice(0, 90))
  }

  let frame = null
  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue
    const hit = await f
      .getByText('Card', { exact: true })
      .first()
      .isVisible()
      .catch(() => false)
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

  // Submit lives in a sibling Stripe frame, not the one holding the method
  // rows — scan for it the same way.
  let submitted = false
  for (const f of [frame, ...page.frames()]) {
    const btn = f.getByRole('button', { name: /submit|pay now|^pay$|continue/i }).first()
    if (await btn.isVisible({ timeout: 1500 }).catch(() => false)) {
      await btn.click()
      console.log('submitted payment method via', (f.name() || 'main').slice(0, 40))
      submitted = true
      break
    }
  }
  if (!submitted) throw new Error('submit button not found in any frame')

  // Let the session-create (and, with --checkout, performCheckout) play out.
  await page.waitForTimeout(25000)

  const text = await page.locator('main').innerText()
  console.log('--- final pay-step text ---')
  console.log(text.split('\n').filter(Boolean).slice(-8).join('\n'))

  await page.screenshot({ path: '/private/tmp/claude-501/-Users-joshuaphelps-Puente-PuenteApp/9c5e5334-2cf8-420c-84e0-73be0e9f1d14/scratchpad/drive-final.png', fullPage: true })
  await browser.close()
}

main().catch((err) => {
  console.error('DRIVE FAILED:', err.message)
  process.exit(1)
})
