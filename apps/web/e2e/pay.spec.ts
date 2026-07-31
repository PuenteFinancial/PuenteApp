import { test, expect, type BrowserContext } from '@playwright/test'

// The pay step (PR-S3): the funding-session fetch that now fronts every
// PENDING_PAYMENT affordance, the retryable error card, and the js.stripe.com
// seam. The real Payment Element never renders in CI — the stripe fixture's
// loader request is deliberately aborted, which proves the dynamic-import seam
// fails into the error card instead of a hung form. The Element's real mount is
// a close-out-session item against the Stripe sandbox.

async function signIn(context: BrowserContext) {
  await context.addCookies([
    { name: 'puente_session', value: 'e2e-token', url: 'http://localhost:3100' },
  ])
}

test('the simulate affordance still renders behind the funding-session fetch', async ({
  context,
  page,
}) => {
  await signIn(context)
  // transfer-e2e-1 gets the default mock-provider session; the button must
  // survive the new indirection (fetch → affordance branch → simulate).
  await page.goto('/dashboard/send/transfer-e2e-1')

  await expect(page.getByRole('button', { name: /simulate payment|simular pago/i })).toBeVisible()
})

test('a funding-session failure renders the retryable error card, not a silent gap', async ({
  context,
  page,
}) => {
  await signIn(context)
  await page.goto('/dashboard/send/transfer-e2e-session-fail')

  // The tracker itself still works (timeline visible)…
  await expect(page.getByText(/waiting for payment|esperando el pago/i)).toBeVisible()
  // …the pay area shows the error + retry, and no simulate button leaks through.
  await expect(
    page.getByText(/could not load the payment form|no pudimos cargar el formulario/i),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: /retry|reintentar/i })).toBeVisible()
  await expect(page.getByRole('button', { name: /simulate payment|simular pago/i })).toHaveCount(0)
})

test('a blocked Stripe loader fails into the error card — the dynamic-import seam holds', async ({
  context,
  page,
}) => {
  await signIn(context)
  // Abort every request to js.stripe.com BEFORE navigation: CI must never
  // depend on that origin, and a load failure must surface as the retryable
  // card rather than a permanently-pending form.
  await page.route('**/js.stripe.com/**', (route) => route.abort())
  await page.goto('/dashboard/send/transfer-e2e-stripe-1')

  await expect(
    page.getByText(/could not load the payment form|no pudimos cargar el formulario/i),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: /retry|reintentar/i })).toBeVisible()
  // The simulate stand-in must not appear on a stripe-provider transfer.
  await expect(page.getByRole('button', { name: /simulate payment|simular pago/i })).toHaveCount(0)
})
