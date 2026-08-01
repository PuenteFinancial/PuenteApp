import { test, expect, type BrowserContext } from '@playwright/test'

// 8.5-v1 ops board — one happy-path render spec against the mock fixture. The
// allowlist gate (404-never-403) is covered by API route tests; the mock API
// ignores auth by design, so this spec proves only that a well-formed overview
// renders every panel. Default UI language is Spanish; matchers accept both.

async function signIn(context: BrowserContext) {
  await context.addCookies([
    { name: 'puente_session', value: 'e2e-token', url: 'http://localhost:3100' },
  ])
}

test('renders the needs-you queue and state-of-world panels', async ({ context, page }) => {
  await signIn(context)
  await page.goto('/dashboard/ops')

  await expect(
    page.getByRole('heading', { name: /operations overview|panel de operaciones/i }),
  ).toBeVisible()

  // Float ceiling tripped banner (needs-you).
  await expect(page.getByText(/float ceiling tripped|techo de flotación alcanzado/i)).toBeVisible()

  // Pending cancellation row: total (send+fee) and the out-of-window annotation.
  await expect(page.getByText('$505.50')).toBeVisible()
  await expect(page.getByText(/out of window|fuera del plazo/i)).toBeVisible()

  // Held over-threshold transfer with its hold annotation.
  await expect(page.getByText(/velocity review|revisión de velocidad/i)).toBeVisible()

  // Latest recon findings names the failing check.
  await expect(page.getByText('bridge_wallet_float').first()).toBeVisible()

  // State of the world: counts, balances (as-of note), runs strip.
  await expect(page.getByText('COMPLETED')).toBeVisible()
  await expect(page.getByText(/as of last reconciliation|al cierre de la última conciliación/i)).toBeVisible()
  await expect(page.getByText(/reconciliation runs|corridas de conciliación/i)).toBeVisible()

  // Read-only: no action buttons anywhere except the language toggle chrome.
  await expect(page.getByRole('button', { name: /refund|cancel|resolve|reembols/i })).toHaveCount(0)
})
