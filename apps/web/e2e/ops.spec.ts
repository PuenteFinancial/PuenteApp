import { test, expect, type BrowserContext, type Page } from '@playwright/test'

// 8.5 ops board specs against the mock fixture. The allowlist/write gate
// (404-never-403, double control) is covered by API route tests; the mock API
// ignores auth by design. v1 proved the read renders; v1.1 adds the three
// resolve-cancellation flows: refund happy path, deny with the typed evidence
// gate, and the refund_owed legal refusal. Default UI language is Spanish;
// matchers accept both.

async function signIn(context: BrowserContext) {
  await context.addCookies([
    { name: 'puente_session', value: 'e2e-token', url: 'http://localhost:3100' },
  ])
}

// The two pending-cancellation cards are distinguished by their window pill
// (every fixture id shortens to the same 'transfer' prefix on screen).
function pendingCard(page: Page, windowText: RegExp) {
  return page
    .locator('div')
    .filter({ has: page.getByText(windowText) })
    .filter({ has: page.getByRole('button', { name: /^(refund|reembolsar)$/i }) })
    .last()
}

const IN_WINDOW = /within window|dentro del plazo/i
const OUT_OF_WINDOW = /out of window|fuera del plazo/i

test('renders the needs-you queue and state-of-world panels', async ({ context, page }) => {
  await signIn(context)
  await page.goto('/dashboard/ops')

  await expect(
    page.getByRole('heading', { name: /operations overview|panel de operaciones/i }),
  ).toBeVisible()

  // Float ceiling tripped banner (needs-you).
  await expect(page.getByText(/float ceiling tripped|techo de flotación alcanzado/i)).toBeVisible()

  // Pending cancellation rows: totals (send+fee) and both window annotations.
  await expect(page.getByText('$505.50')).toBeVisible()
  await expect(page.getByText('$203.00')).toBeVisible()
  await expect(page.getByText(OUT_OF_WINDOW)).toBeVisible()
  await expect(page.getByText(IN_WINDOW)).toBeVisible()

  // Held over-threshold transfer with its hold annotation.
  await expect(page.getByText(/velocity review|revisión de velocidad/i)).toBeVisible()

  // Latest recon findings names the failing check.
  await expect(page.getByText('bridge_wallet_float').first()).toBeVisible()

  // State of the world: counts, balances (as-of note), runs strip.
  await expect(page.getByText('COMPLETED')).toBeVisible()
  await expect(page.getByText(/as of last reconciliation|al cierre de la última conciliación/i)).toBeVisible()
  await expect(page.getByText(/reconciliation runs|corridas de conciliación/i)).toBeVisible()

  // v1.1: actionsEnabled is true in the fixture, so each pending-cancellation
  // row carries exactly its Refund + Deny pair — and nothing else grew buttons.
  await expect(page.getByRole('button', { name: /^(refund|reembolsar)$/i })).toHaveCount(2)
  await expect(page.getByRole('button', { name: /^(deny|denegar)$/i })).toHaveCount(2)
})

test('refund happy path: confirm modal shows the correction amount, then the outcome', async ({
  context,
  page,
}) => {
  await signIn(context)
  await page.goto('/dashboard/ops')

  const card = pendingCard(page, IN_WINDOW)
  await card.getByRole('button', { name: /^(refund|reembolsar)$/i }).click()

  // Consequence ceremony: amount + copy, then an explicit confirm.
  await expect(card.getByText(/correction payment|pago de corrección/i).first()).toBeVisible()
  await expect(card.getByText('$203.00').last()).toBeVisible()
  await card.getByRole('button', { name: /confirm refund|confirmar reembolso/i }).click()

  await expect(
    card.getByText(/correction payment sent|pago de corrección enviado/i),
  ).toBeVisible()
  await card.getByRole('button', { name: /^(close|cerrar)$/i }).click()
})

test('deny path: submit is blocked until parseable timezone-explicit evidence is entered', async ({
  context,
  page,
}) => {
  await signIn(context)
  await page.goto('/dashboard/ops')

  const card = pendingCard(page, OUT_OF_WINDOW)
  await card.getByRole('button', { name: /^(deny|denegar)$/i }).click()

  // The typo-direction warning must be on screen before any submit.
  await expect(card.getByText(/earlier timestamp|más temprano/i)).toBeVisible()

  const confirm = card.getByRole('button', { name: /confirm denial|confirmar denegación/i })

  // Empty evidence → blocked client-side.
  await confirm.click()
  await expect(card.getByText(/parseable iso 8601|marca de tiempo iso 8601/i)).toBeVisible()

  // Unparseable evidence → still blocked.
  await card.getByRole('textbox').fill('yesterday-ish')
  await confirm.click()
  await expect(card.getByText(/parseable iso 8601|marca de tiempo iso 8601/i)).toBeVisible()

  // Parseable but timezone-less → still blocked (a bare local time would
  // silently shift the evidence by the operator's UTC offset).
  await card.getByRole('textbox').fill('2026-08-01T09:45:00')
  await confirm.click()
  await expect(card.getByText(/parseable iso 8601|marca de tiempo iso 8601/i)).toBeVisible()

  // Real evidence → denied.
  await card.getByRole('textbox').fill('2026-08-01T09:45:00Z')
  await confirm.click()
  await expect(card.getByText(/request closed|solicitud cerrada/i)).toBeVisible()
})

test('refund_owed refusal renders the legal explanation, not a generic error', async ({
  context,
  page,
}) => {
  await signIn(context)
  await page.goto('/dashboard/ops')

  // Denying the WITHIN-window request trips the mock's refund_owed refusal.
  const card = pendingCard(page, IN_WINDOW)
  await card.getByRole('button', { name: /^(deny|denegar)$/i }).click()
  await card.getByRole('textbox').fill('2026-08-01T12:00:00Z')
  await card.getByRole('button', { name: /confirm denial|confirmar denegación/i }).click()

  await expect(card.getByText(/refund is owed|se debe un reembolso/i)).toBeVisible()
})
