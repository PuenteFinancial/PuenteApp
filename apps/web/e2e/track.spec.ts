import { test, expect, type BrowserContext } from '@playwright/test'

// Transfer tracker: the status timeline, the dev simulate-pay stand-in, and all
// three cancel branches (200 refunded / 202 support routing / 409 refused).
// Each spec owns its own transfer fixture in e2e/mock-api.mjs so they stay safe
// under fullyParallel and under a CI retry. Default UI language is Spanish, so
// matchers accept either locale.

async function signIn(context: BrowserContext) {
  await context.addCookies([
    { name: 'puente_session', value: 'e2e-token', url: 'http://localhost:3100' },
  ])
}

test('tracker renders the status timeline for a pending transfer', async ({ context, page }) => {
  await signIn(context)
  await page.goto('/dashboard/send/transfer-e2e-1')

  await expect(page.getByRole('heading', { name: /your transfer|tu transferencia/i })).toBeVisible()

  // Every step of the happy path is listed, with the amounts.
  await expect(page.getByText(/waiting for payment|esperando el pago/i)).toBeVisible()
  await expect(page.getByText(/payment received|pago recibido/i)).toBeVisible()
  await expect(page.getByText(/^(delivered|entregada)$/i)).toBeVisible()
  await expect(page.getByText(/1,689\.52 MXN/)).toBeVisible()

  // Not cancelable before funding, and no outcome banner while in flight.
  await expect(page.getByRole('button', { name: /cancel transfer|cancelar transferencia/i })).toHaveCount(0)
})

test('simulate payment advances the transfer to funded', async ({ context, page }, testInfo) => {
  await signIn(context)
  // Per-ATTEMPT id: the mock's state map outlives a retry (one webServer per
  // run), so a fixed id would come back already FUNDED on attempt 2, the
  // Simulate button would never render, and the retry would fail deterministically.
  await page.goto(`/dashboard/send/transfer-e2e-sim-${testInfo.retry}`)

  await page.getByRole('button', { name: /simulate payment|simular pago/i }).click()

  // Funding landed → the cancel window opens and the button appears.
  await expect(
    page.getByRole('button', { name: /cancel transfer|cancelar transferencia/i }),
  ).toBeVisible()
  await expect(page.getByText(/left to cancel this transfer|para cancelar esta transferencia/i)).toBeVisible()

  // The stand-in disappears once there is nothing left to pay for.
  await expect(page.getByRole('button', { name: /simulate payment|simular pago/i })).toHaveCount(0)
})

test('the tracker polls and picks up a state change with no user action', async ({ context, page }) => {
  await signIn(context)
  // This fixture id reports PENDING_PAYMENT on the first read and FUNDED after,
  // so the ONLY thing that can advance this screen is the poll itself — no
  // click, no reload. Covers the interval, the isSettled gate that would have
  // stopped it, and shape-guarded adoption of the new state.
  await page.goto('/dashboard/send/transfer-e2e-advance-1')

  await expect(page.getByText(/waiting for payment|esperando el pago/i)).toBeVisible()
  await expect(page.getByRole('button', { name: /cancel transfer|cancelar transferencia/i })).toHaveCount(0)

  // Poll interval is 5 s; allow a margin without making the spec slow.
  await expect(
    page.getByRole('button', { name: /cancel transfer|cancelar transferencia/i }),
  ).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText(/left to cancel this transfer|para cancelar esta transferencia/i)).toBeVisible()
})

test('cancel requires two taps, then refunds', async ({ context, page }) => {
  await signIn(context)
  await page.goto('/dashboard/send/transfer-e2e-cancel')

  const cancel = page.getByRole('button', { name: /cancel transfer|cancelar transferencia/i })
  await expect(cancel).toBeVisible()

  // First tap only arms — nothing is canceled yet.
  await cancel.click()
  await expect(page.getByRole('button', { name: /tap again|toca de nuevo/i })).toBeVisible()
  await expect(page.getByText(/refunded|reembolsada/i)).toHaveCount(0)

  // Second tap commits.
  await page.getByRole('button', { name: /tap again|toca de nuevo/i }).click()
  await expect(page.getByText(/refunded in full|reembolsó el monto total/i)).toBeVisible()

  // Terminal: the cancel affordance is gone.
  await expect(page.getByRole('button', { name: /cancel transfer|cancelar transferencia/i })).toHaveCount(0)
})

test('a cancel that needs support shows the server-authored Reg E copy', async ({ context, page }) => {
  await signIn(context)
  await page.goto('/dashboard/send/transfer-e2e-support')

  await page.getByRole('button', { name: /cancel transfer|cancelar transferencia/i }).click()
  await page.getByRole('button', { name: /tap again|toca de nuevo/i }).click()

  // The 202 is NOT an error: the server's own wording is shown verbatim, and it
  // affirms the refund-if-the-payout-fails tail. Assert on the distinctive tail
  // rather than "contact support" — that phrase also appears in our own mapped
  // fallback string AND in the support link, so matching it proves nothing
  // about which copy actually rendered.
  await expect(
    page.getByText(/being sent for payout|se está enviando para su pago/i),
  ).toBeVisible()
  await expect(page.getByText(/refunded in full|reembolsará el monto total/i)).toBeVisible()

  // A message telling the sender to contact support must come with a route to
  // do so, pointing at the SAME address as the Reg E disclosure's contact line.
  await expect(
    page.getByRole('link', { name: /contact support|comunícate con soporte/i }),
  ).toHaveAttribute('href', 'mailto:support@puentefinancial.com')
})

test('a cancel past the window shows the refusal reason', async ({ context, page }) => {
  await signIn(context)
  await page.goto('/dashboard/send/transfer-e2e-late')

  await page.getByRole('button', { name: /cancel transfer|cancelar transferencia/i }).click()
  await page.getByRole('button', { name: /tap again|toca de nuevo/i }).click()

  await expect(
    page.getByText(/can no longer be canceled|ya no se puede cancelar/i),
  ).toBeVisible()
})
