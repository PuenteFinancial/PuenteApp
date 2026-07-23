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
