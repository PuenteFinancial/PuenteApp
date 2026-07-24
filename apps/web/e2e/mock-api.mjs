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
    completedAt: state === 'COMPLETED' ? new Date().toISOString() : null,
    createdAt: new Date(START).toISOString(),
    disclosures: [],
  }
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
        messages: {
          en: "This transfer is being sent for payout and can't be canceled automatically. Contact support to exercise your cancellation right — if the payout does not complete, you will be refunded in full.",
          es: 'Esta transferencia se está enviando para su pago y no se puede cancelar automáticamente. Comunícate con soporte para ejercer tu derecho de cancelación: si el pago no se completa, se te reembolsará el monto total.',
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
      content: {
        version: 1,
        amounts: { sendMinor: 9800, feeMinor: 200, totalMinor: 10000, sendCurrency: 'USD', receiveMinor: 168952, receiveCurrency: 'MXN', fxRate: '17.2400' },
        cancelWindowMinutes: 30,
        en: {
          title: 'Prepayment disclosure',
          amountLines: ['Transfer amount: $98.00', 'Transfer fee: $2.00', 'Total to pay: $100.00', 'Amount to be received: 1,689.52 MXN'],
          fxRateLine: 'Exchange rate: 1 USD = 17.2400 MXN',
          cancellationRights: 'You have the right to cancel this transfer and receive a full refund for 30 minutes after you pay, unless the funds have already been submitted for payout.',
          errorResolutionRights: 'You have the right to dispute errors in this transfer. Contact us within 180 days of the promised delivery date.',
          wrongAccountWarning: 'Make sure the recipient account number (CLABE) is correct. An incorrect account number may mean you lose the transfer amount.',
          contact: 'Puente Financial — support@puentefinancial.com',
        },
        es: {
          title: 'Divulgación previa al pago',
          amountLines: ['Monto de la transferencia: $98.00 USD', 'Comisión por transferencia: $2.00 USD', 'Total a pagar: $100.00 USD', 'Monto a recibir: 1,689.52 MXN'],
          fxRateLine: 'Tipo de cambio: 1 USD = 17.2400 MXN',
          cancellationRights: 'Tiene derecho a cancelar esta transferencia y recibir un reembolso completo durante los 30 minutos posteriores al pago, salvo que los fondos ya hayan sido enviados para su entrega.',
          errorResolutionRights: 'Tiene derecho a disputar errores en esta transferencia. Contáctenos dentro de los 180 días posteriores a la fecha de entrega prometida.',
          wrongAccountWarning: 'Verifique que el número de cuenta del destinatario (CLABE) sea correcto. Un número incorrecto puede significar la pérdida del monto transferido.',
          contact: 'Puente Financial — support@puentefinancial.com',
        },
      },
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
