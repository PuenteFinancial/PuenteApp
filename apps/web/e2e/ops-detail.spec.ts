import { test, expect, type BrowserContext } from '@playwright/test'

// Ops board slice 1: the refund backlog panel and the per-transfer detail
// page, against the mock fixture. The allowlist gate (404-never-403) and the
// output allowlist are covered by API route tests; the mock ignores auth by
// design. Default UI language is Spanish; matchers accept both.

async function signIn(context: BrowserContext) {
  await context.addCookies([
    { name: 'puente_session', value: 'e2e-token', url: 'http://localhost:3100' },
  ])
}

const HELD_1 = '4e1d0001-0000-4000-8000-000000000003'
const FAILED_1 = 'fa11ed01-0000-4000-8000-000000000005'
const FAILED_ABANDONED = 'fa11ed02-0000-4000-8000-000000000006'
// O-B: detail passes preflight, the POST refuses — "the row moved".
const FAILED_RACED = 'fa11ed03-0000-4000-8000-000000000007'
const FAILED_STUCK = 'fa11ed04-0000-4000-8000-000000000008'

const NOTE = 'e2e: verified the sender by phone; both sends today are legitimate.'

test('board: refund backlog panel lists failed payouts with their claim state, oldest first', async ({
  context,
  page,
}) => {
  await signIn(context)
  await page.goto('/dashboard/ops')

  await expect(page.getByText(/refund backlog|reembolsos pendientes/i)).toBeVisible()
  // Needs-you header counts the backlog beside holds.
  await expect(page.getByText(/PAYOUT_FAILED \(2\)/)).toBeVisible()
  // Totals (send + fee) and the two claim pills.
  await expect(page.getByText('$200.00')).toBeVisible()
  await expect(page.getByText('$81.49')).toBeVisible()
  await expect(page.getByText(/^(unclaimed|sin claim)$/i)).toBeVisible()
  await expect(page.getByText(/^(claim abandoned|claim abandonado)$/i)).toBeVisible()
  // The abandoned row never reached Bridge — the pre-submit tag says so.
  await expect(page.getByText(/pre-submit|pre-envío/i)).toBeVisible()
})

test('board card id links to the detail page, which shows the hold guidance', async ({ context, page }) => {
  await signIn(context)
  await page.goto('/dashboard/ops')

  await page.getByRole('link', { name: HELD_1.slice(0, 8) }).first().click()
  await expect(page).toHaveURL(new RegExp(`/dashboard/ops/transfers/${HELD_1}$`))

  // Header: state pill + the full id.
  await expect(page.getByRole('heading', { name: /transfer|transferencia/i })).toBeVisible()
  // Exact: the id also appears inside the ledger idempotency key `<id>:FUNDED`.
  await expect(page.getByText(HELD_1, { exact: true })).toBeVisible()
  // .first(): the state pill; the ledger batch label below also reads FUNDED.
  await expect(page.getByText(/^FUNDED$/).first()).toBeVisible()

  // Hold section: the reason and the runbook's velocity_review guidance.
  await expect(page.getByText(/velocity review|revisión de velocidad/i)).toBeVisible()
  await expect(page.getByText(/cancel and refund instead|cancela y reembolsa/i)).toBeVisible()

  // Timeline + ledger render, and the ledger is balanced.
  await expect(page.getByText('PENDING_PAYMENT → FUNDED')).toBeVisible()
  await expect(page.getByText(/every batch nets to zero|cada lote suma cero/i)).toBeVisible()
  await expect(page.getByText('DR funding_receivable')).toBeVisible()

  // Back link returns to the board.
  await page.getByRole('link', { name: /back to the board|volver al tablero/i }).click()
  await expect(page).toHaveURL(/\/dashboard\/ops$/)
})

test('detail: a failed payout with a recorded return shows refund preflight passing', async ({
  context,
  page,
}) => {
  await signIn(context)
  await page.goto(`/dashboard/ops/transfers/${FAILED_1}`)

  await expect(page.getByText(/^PAYOUT_FAILED$/)).toBeVisible()
  await expect(page.getByText(/^(unclaimed|sin claim)$/i)).toBeVisible()
  await expect(page.getByText(/recorded checks pass|verificaciones registradas pasan/i)).toBeVisible()
  await expect(page.getByText('SUBMITTED → PAYOUT_FAILED')).toBeVisible()
  await expect(page.getByText('bridge/returned')).toBeVisible()
})

test('detail: an abandoned refund claim renders the STOP guidance, no refund button', async ({
  context,
  page,
}) => {
  await signIn(context)
  await page.goto(`/dashboard/ops/transfers/${FAILED_ABANDONED}`)

  await expect(page.getByText(/^(claim abandoned|claim abandonado)$/i)).toBeVisible()
  await expect(page.getByText(/manual-refund\.md/)).toBeVisible()
  // O-B adds action buttons; the abandoned state must never grow one.
  await expect(page.getByRole('button', { name: /refund|reembols/i })).toHaveCount(0)
})

// ── O-B: the two actions ─────────────────────────────────────────────────────

test('release hold: the confirm button stays disabled until a real note is typed, then reports released', async ({
  context,
  page,
}) => {
  await signIn(context)
  await page.goto(`/dashboard/ops/transfers/${HELD_1}`)

  await page.getByRole('button', { name: /^(release hold|liberar retención)$/i }).click()
  const confirm = page.getByRole('button', { name: /^(confirm release|confirmar liberación)/i })
  await expect(confirm).toBeDisabled()
  // The consequence is stated before the note is asked for.
  await expect(page.getByText(/submits the payout to bridge|envía el payout a bridge/i)).toBeVisible()

  const note = page.getByLabel(/what you verified|qué verificaste/i)
  await note.fill('too short')
  await expect(confirm).toBeDisabled()
  await expect(page.getByText(/at least 10 characters|al menos 10 caracteres/i)).toBeVisible()

  await note.fill(NOTE)
  await expect(confirm).toBeEnabled()
  await confirm.click()

  await expect(page.getByText(/payout submission queued|envío del payout en cola/i)).toBeVisible()
  await page.getByRole('button', { name: /^(close|cerrar)$/i }).click()
  await expect(page.getByRole('button', { name: /^(release hold|liberar retención)$/i })).toBeVisible()
})

test('refund: happy path restates the amount, then shows the outcome and both ledger batches', async ({
  context,
  page,
}) => {
  await signIn(context)
  await page.goto(`/dashboard/ops/transfers/${FAILED_1}`)

  await page.getByRole('button', { name: /^(refund|reembolsar)$/i }).click()
  // send + fee for failed-1: $198.01 + $1.99 — shown once in the header's Total
  // row and RESTATED inside the confirm panel, so exactly two.
  await expect(page.getByText('$200.00')).toHaveCount(2)
  await expect(page.getByText(/not reversible|no es reversible/i)).toBeVisible()

  await page.getByLabel(/what you verified|qué verificaste/i).fill(NOTE)
  await page.getByRole('button', { name: /^(confirm refund|confirmar reembolso)$/i }).click()

  await expect(page.getByText(/correction payment sent|pago de corrección enviado/i)).toBeVisible()
  await expect(page.getByText(`${FAILED_1}:bridge_return`)).toBeVisible()
  await expect(page.getByText(`${FAILED_1}:REFUNDED`, { exact: true })).toBeVisible()
  await expect(page.getByText(/ledger batch is missing|falta un lote esperado/i)).toHaveCount(0)
})

test('refund: a claim that went abandoned after the page loaded renders the DANGER panel with no retry', async ({
  context,
  page,
}) => {
  await signIn(context)
  await page.goto(`/dashboard/ops/transfers/${FAILED_RACED}`)

  await page.getByRole('button', { name: /^(refund|reembolsar)$/i }).click()
  await page.getByLabel(/what you verified|qué verificaste/i).fill(NOTE)
  await page.getByRole('button', { name: /^(confirm refund|confirmar reembolso)$/i }).click()

  await expect(page.getByText(/^(danger|peligro):/i)).toBeVisible()
  await expect(page.getByText(/manual-refund\.md/)).toBeVisible()
  // No retry affordance — only Close, which refreshes the (now stale) page.
  await expect(page.getByRole('button', { name: /^(confirm refund|confirmar reembolso)$/i })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^(close|cerrar)$/i })).toBeVisible()
})

test('refund: Bridge disagreeing about the principal renders the STOP panel with no retry', async ({
  context,
  page,
}) => {
  await signIn(context)
  await page.goto(`/dashboard/ops/transfers/${FAILED_STUCK}`)

  await page.getByRole('button', { name: /^(refund|reembolsar)$/i }).click()
  await page.getByLabel(/what you verified|qué verificaste/i).fill(NOTE)
  await page.getByRole('button', { name: /^(confirm refund|confirmar reembolso)$/i }).click()

  await expect(page.getByText(/^(stop|alto):/i)).toBeVisible()
  // The API's detail rides through verbatim: the operator sees Bridge's state.
  await expect(page.getByText(/bridge=refund_failed/)).toBeVisible()
  await expect(page.getByRole('button', { name: /^(confirm refund|confirmar reembolso)$/i })).toHaveCount(0)
})

test('detail: an unknown id renders Next not-found, and a malformed id never reaches the API', async ({
  context,
  page,
}) => {
  await signIn(context)

  const unknown = await page.goto('/dashboard/ops/transfers/aaaaaaaa-0000-4000-8000-0000000000ff')
  expect(unknown?.status()).toBe(404)

  const malformed = await page.goto('/dashboard/ops/transfers/not-a-uuid')
  expect(malformed?.status()).toBe(404)
})
