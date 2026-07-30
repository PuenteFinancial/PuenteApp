import { test, expect, type BrowserContext } from '@playwright/test'

// Receipt view: the Reg E receipt for a delivered transfer, the tracker link
// that reaches it, and the redirect-to-tracker for a transfer that has no
// receipt yet. Default UI language is Spanish, so matchers accept either locale.

async function signIn(context: BrowserContext) {
  await context.addCookies([
    { name: 'puente_session', value: 'e2e-token', url: 'http://localhost:3100' },
  ])
}

test('renders the Reg E receipt for a delivered transfer', async ({ context, page }) => {
  await signIn(context)
  await page.goto('/dashboard/send/transfer-e2e-completed/receipt')

  // Neutral chrome — the page title … (the chrome completed-on line is gone in
  // v2: the server-authored date-available line owns the date)
  await expect(
    page.getByRole('heading', { name: /transfer receipt|recibo de transferencia/i }),
  ).toBeVisible()

  // … over the server-authored content, rendered verbatim (amount line, the MXN
  // received, and the Reg E contact address).
  await expect(page.getByText(/total to pay|total a pagar/i)).toBeVisible()
  await expect(page.getByText(/1,689\.52 MXN/)).toBeVisible()
  await expect(page.getByText('support@puentefinancial.com')).toBeVisible()

  // Content v2 (PR7): the receipt announces itself and carries the
  // §1005.31(b)(2)(ii)/(iii) lines, rendered from the server verbatim.
  await expect(page.getByRole('heading', { name: /^(receipt|recibo)$/i })).toBeVisible()
  await expect(page.getByText(/recipient: |destinatario: /i)).toBeVisible()
  await expect(page.getByText(/date available: |fecha de disponibilidad: /i)).toBeVisible()

  await expect(
    page.getByRole('link', { name: /view all transfers|ver todas las transferencias/i }),
  ).toBeVisible()
})

test('the delivered tracker links to the receipt', async ({ context, page }) => {
  await signIn(context)
  await page.goto('/dashboard/send/transfer-e2e-completed')

  // The delivered outcome offers the receipt.
  await expect(page.getByRole('heading', { name: /^(delivered|entregada)$/i })).toBeVisible()
  await page.getByRole('link', { name: /view receipt|ver recibo/i }).click()

  await page.waitForURL(/\/dashboard\/send\/transfer-e2e-completed\/receipt$/)
  await expect(
    page.getByRole('heading', { name: /transfer receipt|recibo de transferencia/i }),
  ).toBeVisible()
})

test('a receipt for a transfer that is not delivered redirects to its tracker', async ({ context, page }) => {
  await signIn(context)
  // A fresh id reports PENDING_PAYMENT — no receipt exists yet, so rather than a
  // broken-looking 404 the page sends the sender to the live tracker.
  await page.goto('/dashboard/send/transfer-e2e-receipt-pending/receipt')

  await page.waitForURL(/\/dashboard\/send\/transfer-e2e-receipt-pending$/)
  await expect(page.getByRole('heading', { name: /your transfer|tu transferencia/i })).toBeVisible()
})

test('a delivered transfer whose receipt is not ready shows a retryable error, not a crash', async ({ context, page }) => {
  await signIn(context)
  // COMPLETED, but the receipt row 404s (write race). The page must render the
  // retryable load error — not notFound(), not a raw crash.
  await page.goto('/dashboard/send/transfer-e2e-completed-noreceipt/receipt')

  await expect(
    page.getByText(/couldn.t load this transfer|no pudimos cargar esta transferencia/i),
  ).toBeVisible()
})
