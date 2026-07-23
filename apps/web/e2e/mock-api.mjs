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

const server = createServer((req, res) => {
  req.resume() // drain any request body
  const { pathname } = new URL(req.url, `http://localhost:${PORT}`)
  const method = req.method

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

  return json(res, 404, { error: { code: 'not_found', message: 'mock: no route', requestId: 'mock' } })
})

server.listen(PORT, () => {
  console.log(`mock API listening on http://localhost:${PORT}`)
})
