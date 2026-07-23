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

  return json(res, 404, { error: { code: 'not_found', message: 'mock: no route', requestId: 'mock' } })
})

server.listen(PORT, () => {
  console.log(`mock API listening on http://localhost:${PORT}`)
})
