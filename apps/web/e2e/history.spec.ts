import { test, expect, type BrowserContext } from '@playwright/test'

// Transfer history: the money-moved transaction list (abandoned sends filtered
// out server-side), Load-more pagination, row → tracker navigation, and the
// empty state. Default UI language is Spanish, so matchers accept either locale.

async function signIn(context: BrowserContext, token = 'e2e-token') {
  await context.addCookies([
    { name: 'puente_session', value: token, url: 'http://localhost:3100' },
  ])
}

test('lists money-moved transfers and hides abandoned sends', async ({ context, page }) => {
  await signIn(context)
  await page.goto('/dashboard/transfers')

  await expect(
    page.getByRole('heading', { name: /transfer history|historial de transferencias/i }),
  ).toBeVisible()

  // Delivered, canceled and in-flight rows all show, each with the exact label
  // its tracker uses.
  await expect(page.getByText(/^(delivered|entregada)$/i)).toBeVisible()
  await expect(page.getByText(/^(canceled|cancelada)$/i)).toBeVisible()
  await expect(page.getByText(/payment received|pago recibido/i)).toBeVisible()

  // The abandoned (never-funded) PAYMENT_FAILED transfer is filtered out by
  // scope=history — it is not a transaction and must not appear.
  await expect(page.getByText(/payment failed|el pago falló/i)).toHaveCount(0)
})

test('a history row links to its tracker', async ({ context, page }) => {
  await signIn(context)
  await page.goto('/dashboard/transfers')

  await page.getByRole('link').filter({ hasText: /delivered|entregada/i }).first().click()

  await page.waitForURL(/\/dashboard\/send\/transfer-e2e-completed$/)
  await expect(page.getByRole('heading', { name: /your transfer|tu transferencia/i })).toBeVisible()
})

test('Load more pages in the rest of the history', async ({ context, page }) => {
  await signIn(context)
  await page.goto('/dashboard/transfers')

  const loadMore = page.getByRole('button', { name: /load more|cargar más/i })
  await expect(loadMore).toBeVisible()

  // The second page is the last — the button disappears once its cursor is null.
  await loadMore.click()
  await expect(loadMore).toHaveCount(0)

  // The scope filter must hold on page 2 too — a proxy that forwarded scope on
  // the first fetch but dropped it here would leak an abandoned row.
  await expect(page.getByText(/payment failed|el pago falló/i)).toHaveCount(0)
})

test('shows an empty state when there are no transfers', async ({ context, page }) => {
  // The sentinel session token drives the mock's empty list.
  await signIn(context, 'e2e-empty')
  await page.goto('/dashboard/transfers')

  await expect(
    page.getByText(/haven.t sent any transfers|no has enviado ninguna transferencia/i),
  ).toBeVisible()
  await expect(page.getByRole('link', { name: /send money|enviar dinero/i })).toBeVisible()
})

test('a failed first-page load shows a retryable error, not an empty state', async ({ context, page }) => {
  // e2e-fail 500s the list. A 5xx must NEVER read as "you haven't sent anything".
  await signIn(context, 'e2e-fail')
  await page.goto('/dashboard/transfers')

  await expect(
    page.getByText(/couldn.t load your transfers|no pudimos cargar tus transferencias/i),
  ).toBeVisible()
  await expect(page.getByRole('link', { name: /retry|reintentar/i })).toBeVisible()
  await expect(
    page.getByText(/haven.t sent any transfers|no has enviado ninguna transferencia/i),
  ).toHaveCount(0)
})

test('a Load more failure surfaces an error instead of silently ending the list', async ({ context, page }) => {
  // Page 1 succeeds; the page-2 fetch 500s. It must show an error and KEEP the
  // "Load more" button (cursor retained), not silently vanish as if it were the end.
  await signIn(context, 'e2e-loadmore-fail')
  await page.goto('/dashboard/transfers')

  const loadMore = page.getByRole('button', { name: /load more|cargar más/i })
  await expect(loadMore).toBeVisible()
  await loadMore.click()

  await expect(
    page.getByText(/something went wrong on our end|algo salió mal de nuestro lado/i),
  ).toBeVisible()
  await expect(loadMore).toBeVisible()
})
