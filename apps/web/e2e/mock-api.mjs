import { createServer } from 'node:http'

// Mock Fastify API for the Playwright send-flow e2e. Serves the handful of
// endpoints the send screen touches with canned, well-formed responses. Auth is
// ignored (any/no Bearer accepted) — the guards are exercised on the web side,
// not here. This is a TEST FIXTURE, never shipped.
const PORT = Number(process.env.MOCK_API_PORT || 4319)
const START = Date.now()

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

// Transfer-state fixtures for the tracker specs.
//
// FIXED ids always report the same state no matter what a test does to them, so
// specs stay safe under `fullyParallel`: a cancel spec that already drove its
// transfer to REFUNDED still finds it FUNDED on a re-read.
//
// Everything else is stateful in `mutableStates`, which persists for the whole
// Playwright run — the webServer starts ONCE and survives retries. So any spec
// that mutates must use a per-ATTEMPT id (see track.spec.ts), or its retry
// would find the state the first attempt left behind and fail deterministically
// — turning the retry that exists to absorb a flake into a guaranteed red.
const FIXED = new Map([
  ['transfer-e2e-cancel', 'FUNDED'],
  ['transfer-e2e-support', 'FUNDED'],
  ['transfer-e2e-late', 'FUNDED'],
  // Delivered — drives the tracker's "View receipt" link and the receipt view.
  ['transfer-e2e-completed', 'COMPLETED'],
  // Delivered, but its receipt row 404s (write race) — for the receipt error path.
  ['transfer-e2e-completed-noreceipt', 'COMPLETED'],
  // slice-7 PR6b: a transfer still in flight with an OPEN cancellation request,
  // for the pending-cancellation banner.
  ['transfer-e2e-cancel-pending', 'IN_FLIGHT'],
  // …and the same request on a transfer that has since settled, to prove the
  // banner stops rather than contradicting the outcome.
  ['transfer-e2e-cancel-settled', 'REFUNDED'],
  // …and one parked at UNDER_REVIEW (delivered, timely pre-deposit request):
  // the outcome banner IS the cancellation story there, so exactly ONE banner
  // may render (PR6b review fix — the pair used to stack and contradict).
  ['transfer-e2e-cancel-review', 'UNDER_REVIEW'],
])
const mutableStates = new Map()

// Ids matching this advance PENDING_PAYMENT → FUNDED on the second read, so a
// spec can prove the tracker's POLL (not an explicit refresh) picks up a state
// change on its own.
const ADVANCING = /^transfer-e2e-advance/
const readCounts = new Map()

function stateOf(id) {
  const fixed = FIXED.get(id)
  if (fixed) return fixed
  const mutable = mutableStates.get(id)
  if (mutable) return mutable
  if (ADVANCING.test(id)) {
    const seen = (readCounts.get(id) ?? 0) + 1
    readCounts.set(id, seen)
    return seen === 1 ? 'PENDING_PAYMENT' : 'FUNDED'
  }
  return 'PENDING_PAYMENT'
}

// Non-consuming read for handlers that GATE on state without representing a
// tracker poll (funding-session). stateOf() advances the ADVANCING fixtures'
// read budget as a side effect — if the funding-session bootstrap consumed a
// read, the poll spec's "second read flips to FUNDED" contract would silently
// count the wrong requests. Returns the state as of the reads consumed so far.
function peekState(id) {
  const fixed = FIXED.get(id)
  if (fixed) return fixed
  const mutable = mutableStates.get(id)
  if (mutable) return mutable
  if (ADVANCING.test(id)) {
    return (readCounts.get(id) ?? 0) <= 1 ? 'PENDING_PAYMENT' : 'FUNDED'
  }
  return 'PENDING_PAYMENT'
}

// Mirrors the API's transfer response schema (transfers.ts transferResponseSchema).
function transferBody(id, state = stateOf(id)) {
  return {
    id,
    quoteId: 'quote-e2e-1',
    payoutDestinationId: 'dest-1',
    state,
    totalAmount: { amountMinor: 10000, currency: 'USD' },
    sendAmount: { amountMinor: 9800, currency: 'USD' },
    feeAmount: { amountMinor: 200, currency: 'USD' },
    receiveAmount: { amountMinor: 168952, currency: 'MXN' },
    fxRate: '17.2400',
    fundingSourceType: 'ach',
    fundingCleared: false,
    disclosureAcceptedAt: new Date(START).toISOString(),
    paymentAt: state === 'PENDING_PAYMENT' ? null : new Date().toISOString(),
    // Computed per request so the Reg E window is always live, never a fixture
    // that goes stale mid-run.
    cancelableUntil: state === 'FUNDED' ? new Date(Date.now() + 30 * 60 * 1000).toISOString() : null,
    providerTransferRef: null,
    // A flag ORTHOGONAL to state — set on both an in-flight and a settled
    // fixture, because the banner must key off the request AND the state.
    cancellationRequestedAt: id.startsWith('transfer-e2e-cancel-')
      ? new Date(START).toISOString()
      : null,
    completedAt: state === 'COMPLETED' ? new Date().toISOString() : null,
    createdAt: new Date(START).toISOString(),
    disclosures: [],
  }
}

// The Reg E disclosure content block — identical in shape to the API's
// buildPrepaymentDisclosure output (content v2, slice-7 PR7). The receipt
// route serves RECEIPT_CONTENT below, mirroring the API's v2 reality where the
// receipt adds its own title + the (b)(2)(ii)/(iii) lines on top of this
// (isReceiptContent on the web requires both en + es, so both are present).
const DISCLOSURE_CONTENT = {
  version: 2,
  amounts: { sendMinor: 9800, feeMinor: 200, totalMinor: 10000, sendCurrency: 'USD', receiveMinor: 168952, receiveCurrency: 'MXN', fxRate: '17.2400' },
  cancelWindowMinutes: 30,
  en: {
    title: 'Prepayment disclosure',
    amountLines: ['Transfer amount: $98.00', 'Transfer fee: $2.00', 'Total to pay: $100.00', 'Amount to be received: 1,689.52 MXN'],
    fxRateLine: 'Exchange rate: 1 USD = 17.2400 MXN',
    cancellationRights: "You have the right to cancel this transfer and receive a full refund for 30 minutes after you pay, unless the funds have already been picked up by your recipient or deposited into your recipient's account.",
    errorResolutionRights: 'You have the right to dispute errors in this transfer. Contact us within 180 days of the date we promised the funds would be available to your recipient.',
    wrongAccountWarning: 'Make sure the recipient account number (CLABE) is correct. An incorrect account number may mean you lose the transfer amount.',
    contact: 'Puente Financial · support@puentefinancial.com · puentefinancial.com',
  },
  es: {
    title: 'Divulgación previa al pago',
    amountLines: ['Monto de la transferencia: $98.00 USD', 'Comisión por transferencia: $2.00 USD', 'Total a pagar: $100.00 USD', 'Monto a recibir: 1,689.52 MXN'],
    fxRateLine: 'Tipo de cambio: 1 USD = 17.2400 MXN',
    cancellationRights: 'Tiene derecho a cancelar esta transferencia y recibir un reembolso completo durante los 30 minutos posteriores al pago, salvo que los fondos ya hayan sido retirados por el destinatario o depositados en la cuenta del destinatario.',
    errorResolutionRights: 'Tiene derecho a disputar errores en esta transferencia. Contáctenos dentro de los 180 días posteriores a la fecha en que prometimos que los fondos estarían disponibles para su destinatario.',
    wrongAccountWarning: 'Verifique que el número de cuenta del destinatario (CLABE) sea correcto. Un número incorrecto puede significar la pérdida del monto transferido.',
    contact: 'Puente Financial · support@puentefinancial.com · puentefinancial.com',
  },
}

// Receipt content v2 = the prepayment block plus the §1005.31(b)(2) receipt
// items the API's buildReceiptDisclosure now adds.
const RECEIPT_CONTENT = {
  ...DISCLOSURE_CONTENT,
  en: {
    ...DISCLOSURE_CONTENT.en,
    title: 'Receipt',
    recipientLine: 'Recipient: María Hernández García',
    dateAvailableLine: 'Date available: July 24, 2026',
  },
  es: {
    ...DISCLOSURE_CONTENT.es,
    title: 'Recibo',
    recipientLine: 'Destinatario: María Hernández García',
    dateAvailableLine: 'Fecha de disponibilidad: 24 de julio de 2026',
  },
}

// Reads the raw body once and caches it — rejectsEmptyJsonBody consumes the
// stream before any route handler sees it, so a second read would hang.
function readRaw(req) {
  if (req._rawBody !== undefined) return Promise.resolve(req._rawBody)
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
    })
    req.on('end', () => resolve(raw))
  })
}

async function readBody(req) {
  const raw = await readRaw(req)
  try {
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

// Fastify rejects a request declaring `Content-Type: application/json` with an
// empty body ("Body cannot be empty…") BEFORE the handler runs. The web's
// apiFetch always sets that header, so any proxy that forwards a POST without a
// body 400s against the real API. Mirroring that here is what stops a
// permissive mock from green-lighting a proxy that cannot work in production —
// it is exactly how the simulate-funding proxy shipped broken past 8 passing
// specs.
async function rejectsEmptyJsonBody(req, res) {
  if (req.method !== 'POST' && req.method !== 'PATCH') return false
  if (!(req.headers['content-type'] || '').includes('application/json')) return false
  const raw = await readRaw(req)
  req._rawBody = raw
  if (raw.length === 0) {
    json(res, 400, {
      error: {
        code: 'validation_error',
        message: "mock: Body cannot be empty when content-type is set to 'application/json'",
        requestId: 'mock',
      },
    })
    return true
  }
  return false
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://localhost:${PORT}`)
  const method = req.method

  if (await rejectsEmptyJsonBody(req, res)) return

  // The cancel route is the one place this fixture must MIRROR the real API's
  // preconditions rather than wave requests through. The API rejects a cancel
  // twice over — the idempotency plugin 400s a missing Idempotency-Key, and the
  // body schema plus an explicit path/body match check 400 a missing or
  // mismatched transferId. A permissive mock here means a refactor that drops
  // either one still ships green, and every real Reg E cancel then fails with
  // "Please check the details and try again" inside a 30-minute window.
  if (method === 'POST' && /^\/v1\/transfers\/[^/]+\/cancel$/.test(pathname)) {
    const id = pathname.split('/')[3]
    const body = await readBody(req)

    if (!req.headers['idempotency-key']) {
      return json(res, 400, {
        error: { code: 'validation_error', message: 'mock: Idempotency-Key header is required', requestId: 'mock' },
      })
    }
    if (body?.transferId !== id) {
      return json(res, 400, {
        error: { code: 'validation_error', message: 'mock: transferId must match the transfer being canceled', requestId: 'mock' },
      })
    }

    // Reg E 202: accepted for out-of-band handling, never a flat denial. Copy is
    // server-authored in both languages (verbatim from transfers.ts).
    if (id === 'transfer-e2e-support') {
      return json(res, 202, {
        id,
        state: 'SUBMITTED',
        code: 'cancellation_requires_support',
        requestedAt: '2026-07-28T12:00:00.000Z',
        messages: {
          en: "This transfer is already on its way to your recipient, so it can't be stopped automatically. We've recorded your cancellation request. If you asked within 30 minutes of paying and before the money was delivered, you'll get a full refund. This page will update when it's resolved.",
          es: 'Esta transferencia ya va camino a tu destinatario, así que no se puede detener automáticamente. Registramos tu solicitud de cancelación. Si la hiciste dentro de los 30 minutos después de pagar y antes de que se entregara el dinero, recibirás un reembolso completo. Esta página se actualizará cuando se resuelva.',
        },
      })
    }

    if (id === 'transfer-e2e-late') {
      return json(res, 409, {
        error: {
          code: 'transfer_not_cancelable',
          message: 'The cancellation window has passed',
          requestId: 'mock',
        },
      })
    }

    // Deliberately does NOT mutate: the REFUNDED transfer travels in the
    // response body, which is what the client adopts.
    return json(res, 200, transferBody(id, 'REFUNDED'))
  }

  req.resume() // drain any request body

  if (method === 'GET' && pathname === '/v1/ops/overview') {
    // 8.5-v1 ops board fixture. The mock ignores auth by design — the real
    // allowlist gate (404-never-403) is fully covered by API route tests; this
    // serves the happy-path render only.
    return json(res, 200, {
      generatedAt: '2026-08-01T12:00:00.000Z',
      pendingCancellations: [
        {
          transferId: 'transfer-e2e-cancel-1',
          state: 'UNDER_REVIEW',
          sendAmountMinor: 50_000,
          feeAmountMinor: 550,
          requestedAt: '2026-08-01T09:30:00.000Z',
          withinWindow: false,
          refundPaymentRef: null,
        },
      ],
      openTransfers: [
        {
          transferId: 'transfer-e2e-held-1',
          state: 'FUNDED',
          sendAmountMinor: 30_000,
          enteredStateAt: '2026-08-01T08:00:00.000Z',
          dwellMinutes: 240,
          thresholdMinutes: 15,
          overThreshold: true,
          holdReason: 'velocity_review',
          fundingCleared: false,
          submitAttempted: false,
          cancellationRequested: false,
        },
        {
          transferId: 'transfer-e2e-quiet-1',
          state: 'SUBMITTED',
          sendAmountMinor: 12_000,
          enteredStateAt: '2026-08-01T11:55:00.000Z',
          dwellMinutes: 5,
          thresholdMinutes: 30,
          overThreshold: false,
          holdReason: null,
          fundingCleared: false,
          submitAttempted: true,
          cancellationRequested: false,
        },
      ],
      floatCeiling: { configured: true, tripped: true, balanceMinor: 500_100, ceilingMinor: 500_000 },
      transferCounts: [
        { state: 'COMPLETED', count: 12 },
        { state: 'FUNDED', count: 1 },
        { state: 'SUBMITTED', count: 1 },
      ],
      ledgerBalances: {
        asOf: '2026-08-01T06:00:00.000Z',
        balances: [
          { code: 'bridge_wallet_float', amountMinor: 741_200, currency: 'USD' },
          { code: 'funding_receivable', amountMinor: 500_100, currency: 'USD' },
        ],
      },
      reconciliationRuns: [
        {
          createdAt: '2026-08-01T06:00:00.000Z',
          status: 'findings',
          findingsCount: 1,
          checks: [
            { name: 'ledger_net_zero', status: 'pass', findingsCount: 0 },
            { name: 'bridge_wallet_float', status: 'findings', findingsCount: 1 },
          ],
        },
        { createdAt: '2026-07-31T06:00:00.000Z', status: 'pass', findingsCount: 0, checks: [] },
      ],
    })
  }

  if (method === 'GET' && pathname === '/v1/users/me') {
    return json(res, 200, {
      id: 'user-e2e-1',
      firstName: 'Test',
      lastName: 'User',
      email: 'test@example.com',
      kycStatus: 'approved',
      bridgeCustomerId: null,
    })
  }

  if (method === 'GET' && pathname === '/v1/recipients') {
    // Sentinel session token (forwarded as the Bearer) drives the empty state.
    const empty = (req.headers['authorization'] || '') === 'Bearer e2e-empty'
    return json(res, 200, {
      data: empty
        ? []
        : [{ id: 'rec-1', firstName: 'Rosa', lastName: 'Santos', relationship: 'Mother', country: 'MX', status: 'active' }],
    })
  }

  if (method === 'GET' && /^\/v1\/recipients\/[^/]+\/destinations$/.test(pathname)) {
    return json(res, 200, {
      data: [
        { id: 'dest-1', method: 'bank_account', currency: 'MXN', status: 'active', label: 'BBVA', details: { clabeLast4: '4321' } },
      ],
    })
  }

  if (method === 'POST' && pathname === '/v1/quotes') {
    return json(res, 201, {
      id: 'quote-e2e-1',
      payoutDestinationId: 'dest-1',
      totalAmount: { amountMinor: 10000, currency: 'USD' },
      sendAmount: { amountMinor: 9800, currency: 'USD' },
      feeAmount: { amountMinor: 200, currency: 'USD' },
      receiveAmount: { amountMinor: 168952, currency: 'MXN' },
      fxRate: '17.2400',
      expiresAt: new Date(START + 15 * 60 * 1000).toISOString(),
      status: 'active',
      createdAt: new Date(START).toISOString(),
    })
  }

  if (method === 'POST' && pathname === '/v1/transfers') {
    return json(res, 201, {
      id: 'transfer-e2e-1',
      quoteId: 'quote-e2e-1',
      payoutDestinationId: 'dest-1',
      state: 'PENDING_PAYMENT',
      totalAmount: { amountMinor: 10000, currency: 'USD' },
      sendAmount: { amountMinor: 9800, currency: 'USD' },
      feeAmount: { amountMinor: 200, currency: 'USD' },
      receiveAmount: { amountMinor: 168952, currency: 'MXN' },
      fxRate: '17.2400',
      createdAt: new Date(START).toISOString(),
      disclosure: { id: 'disc-prepay-1', type: 'prepayment', locale: 'es', presentedAt: new Date(START).toISOString() },
    })
  }

  if (method === 'GET' && /^\/v1\/transfers\/[^/]+\/disclosure$/.test(pathname)) {
    return json(res, 200, {
      id: 'disc-prepay-1',
      transferId: 'transfer-e2e-1',
      type: 'prepayment',
      locale: 'es',
      presentedAt: new Date(START).toISOString(),
      content: DISCLOSURE_CONTENT,
    })
  }

  // Reg E receipt — 404 until the transfer is COMPLETED (the receipt row is
  // written on delivery), exactly like the real API. Content v2: the receipt's
  // own rendering (Receipt title + recipient + date-available lines).
  if (method === 'GET' && /^\/v1\/transfers\/[^/]+\/receipt$/.test(pathname)) {
    const id = pathname.split('/')[3]
    // Simulates the COMPLETED-but-receipt-not-yet-written race for the error spec.
    if (id === 'transfer-e2e-completed-noreceipt') {
      return json(res, 404, { error: { code: 'not_found', message: 'mock: Receipt not found', requestId: 'mock' } })
    }
    if (stateOf(id) !== 'COMPLETED') {
      return json(res, 404, { error: { code: 'not_found', message: 'mock: Receipt not found', requestId: 'mock' } })
    }
    return json(res, 200, {
      id: 'disc-receipt-1',
      transferId: id,
      type: 'receipt',
      locale: 'es',
      presentedAt: new Date().toISOString(),
      content: RECEIPT_CONTENT,
    })
  }

  if (method === 'POST' && /^\/v1\/transfers\/[^/]+\/confirm$/.test(pathname)) {
    return json(res, 200, {
      id: 'transfer-e2e-1',
      state: 'PENDING_PAYMENT',
      disclosureAcceptedAt: new Date().toISOString(),
      funding: { provider: 'mock', method: 'ach', clientFields: {} },
    })
  }

  // Transfer history list. scope=history hides never-funded (abandoned) sends,
  // exactly like the real API's WHERE clause. A second page (any cursor) proves
  // "Load more" pagination, and the e2e-empty sentinel drives the empty state.
  if (method === 'GET' && pathname === '/v1/transfers') {
    const { searchParams } = new URL(req.url, `http://localhost:${PORT}`)
    const auth = req.headers['authorization'] || ''
    if (auth === 'Bearer e2e-empty') {
      return json(res, 200, { data: [], nextCursor: null })
    }
    // Forced failures for the silent-failure specs: e2e-fail 500s the whole list
    // (proves the first page doesn't render as empty); e2e-loadmore-fail lets
    // page 1 succeed but 500s the "Load more" page (proves it isn't silent).
    if (auth === 'Bearer e2e-fail') {
      return json(res, 500, { error: { code: 'internal_error', message: 'mock: forced list failure', requestId: 'mock' } })
    }
    if (auth === 'Bearer e2e-loadmore-fail' && searchParams.get('cursor')) {
      return json(res, 500, { error: { code: 'internal_error', message: 'mock: forced load-more failure', requestId: 'mock' } })
    }
    // The real API applies the scope filter in SQL on EVERY page. Mirror that
    // here (not just page 1), and seed each page with an abandoned row, so a
    // proxy that forwards scope on the first fetch but drops it on "Load more"
    // is caught — the leaked PAYMENT_FAILED row would surface in the spec.
    const applyScope = (rows) =>
      searchParams.get('scope') === 'history'
        ? rows.filter((tr) => tr.state !== 'PENDING_PAYMENT' && tr.state !== 'PAYMENT_FAILED')
        : rows

    if (searchParams.get('cursor')) {
      const page2 = applyScope([
        transferBody('transfer-e2e-hist-page2', 'COMPLETED'),
        transferBody('transfer-e2e-hist-page2-abandoned', 'PAYMENT_FAILED'),
      ])
      return json(res, 200, { data: page2, nextCursor: null })
    }
    const page1 = applyScope([
      transferBody('transfer-e2e-completed', 'COMPLETED'),
      transferBody('transfer-e2e-hist-funded', 'FUNDED'),
      transferBody('transfer-e2e-hist-canceled', 'CANCELED'),
      transferBody('transfer-e2e-hist-abandoned', 'PAYMENT_FAILED'),
    ])
    return json(res, 200, { data: page1, nextCursor: 'cursor-page-2' })
  }

  // Pay-step bootstrap (PR-S3). Mirrors the real gates: 409 once the transfer
  // has left PENDING_PAYMENT. Default is the mock provider (keeps every
  // simulate spec green); transfer-e2e-stripe* serves a stripe-shaped session
  // (the specs abort js.stripe.com, so the secret never reaches Stripe); and
  // transfer-e2e-session-fail forces the retryable error card.
  if (method === 'GET' && /^\/v1\/transfers\/[^/]+\/funding-session$/.test(pathname)) {
    const id = pathname.split('/')[3]
    if (id === 'transfer-e2e-session-fail') {
      return json(res, 500, { error: { code: 'internal_error', message: 'mock: forced session failure', requestId: 'mock' } })
    }
    // peekState, NOT stateOf: this gate must not consume an ADVANCING read.
    if (peekState(id) !== 'PENDING_PAYMENT') {
      return json(res, 409, { error: { code: 'conflict', message: 'mock: Transfer is no longer awaiting payment', requestId: 'mock' } })
    }
    if (/^transfer-e2e-stripe/.test(id)) {
      return json(res, 200, {
        provider: 'stripe',
        clientSecret: 'pi_e2e_secret_x',
        publishableKey: 'pk_test_e2e',
      })
    }
    return json(res, 200, { provider: 'mock' })
  }

  if (method === 'GET' && /^\/v1\/transfers\/[^/]+$/.test(pathname)) {
    return json(res, 200, transferBody(pathname.split('/')[3]))
  }

  // Dev-only simulate-pay: stands in for the Stripe pay step (PENDING_PAYMENT →
  // FUNDED), exactly as the real dev endpoint drives it via the funding webhook.
  if (method === 'POST' && /^\/v1\/dev\/transfers\/[^/]+\/simulate-funding$/.test(pathname)) {
    mutableStates.set(pathname.split('/')[4], 'FUNDED')
    return json(res, 200, { simulated: true })
  }

  return json(res, 404, { error: { code: 'not_found', message: 'mock: no route', requestId: 'mock' } })
})

server.listen(PORT, () => {
  console.log(`mock API listening on http://localhost:${PORT}`)
})
