import { test, expect } from '@playwright/test'

// Happy path: an approved, verified user reaches the send screen, enters an
// amount, and gets a quote with the FX breakdown. Runs against the mock API
// (e2e/mock-api.mjs); the session cookie is seeded so the server-side guards
// (session → KYC → flag) all pass. Default UI language is Spanish, so matchers
// accept either locale.
test('quote happy path: approved user gets an FX quote', async ({ context, page }) => {
  await context.addCookies([
    { name: 'puente_session', value: 'e2e-token', url: 'http://localhost:3100' },
  ])

  await page.goto('/dashboard/send')

  // Recipient + account are preselected from the single mocked recipient.
  await expect(page.getByLabel(/recipient|destinatario/i)).toBeVisible()
  await expect(page.getByLabel(/account|cuenta/i)).toBeVisible()

  await page.getByLabel(/amount to send|monto a enviar/i).fill('100')
  await page.getByRole('button', { name: /get a quote|obtener cotización/i }).click()

  // The quote breakdown appears: MXN receive amount + the FX rate line.
  await expect(page.getByText(/they receive|ellos reciben/i)).toBeVisible()
  await expect(page.getByText(/1 USD = 17\.24 MXN/)).toBeVisible()
  await expect(page.getByText(/MXN/).first()).toBeVisible()

  // And it is NOT showing the spurious "expired" notice on a fresh quote.
  await expect(page.getByText(/expired|expiró/i)).toHaveCount(0)
})

test('full flow: quote → create → Reg E disclosure → confirm', async ({ context, page }) => {
  await context.addCookies([
    { name: 'puente_session', value: 'e2e-token', url: 'http://localhost:3100' },
  ])

  await page.goto('/dashboard/send')
  await page.getByLabel(/amount to send|monto a enviar/i).fill('100')
  await page.getByRole('button', { name: /get a quote|obtener cotización/i }).click()
  await page.getByText(/they receive|ellos reciben/i).waitFor()

  // Continue → creates the transfer and advances to review.
  await page.getByRole('button', { name: /^(continue|continuar)$/i }).click()

  // The server-authored Reg E prepayment disclosure renders.
  await page.getByText(/prepayment disclosure|divulgación previa al pago/i).waitFor()

  // Confirm is gated on an explicit accept.
  const confirm = page.getByRole('button', { name: /confirm transfer|confirmar transferencia/i })
  await expect(confirm).toBeDisabled()
  await page.getByLabel(/i have read and accept|he leído y acepto/i).check()
  await expect(confirm).toBeEnabled()
  await confirm.click()

  // Confirm hands off to the transfer's own URL — reload-safe, so a sender with
  // money in flight is never stranded on an in-memory step.
  await page.waitForURL(/\/dashboard\/send\/transfer-e2e-1$/)
  await expect(page.getByRole('heading', { name: /your transfer|tu transferencia/i })).toBeVisible()
  await expect(page.getByText(/waiting for payment|esperando el pago/i)).toBeVisible()
})
