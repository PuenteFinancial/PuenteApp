import { describe, it, expect, beforeEach, vi } from 'vitest'

const envMock = vi.hoisted(() => ({ PROXY_TRUST_SECRET: undefined as string | undefined }))
vi.mock('../config/env.js', () => ({ env: envMock }))

const { clientIp, clientUserAgent, isTrustedProxy, PROXY_TRUST_HEADER } = await import(
  './client-origin.js'
)

// AUTHENTICATING THE PROXY HOP.
//
// `x-client-ip` becomes `consents.ip` — the E-SIGN record and the NACHA
// WEB-debit authorization — and `sign_in_events.ip`. The API is reachable
// directly from the internet (measured: a stranger's GET /v1/health on the
// Railway host returns 200), so before this the header was a suggestion from
// whoever sent it, and a forged address was stored indistinguishably from a
// real one.
//
// The property under test is one-directional: a valid secret UPGRADES the
// record from the socket address to the forwarded one. Everything else — no
// secret, wrong secret, absent header — falls back. There is no input that
// produces an attacker-chosen address.

const SECRET = 'a'.repeat(64)
const SOCKET = '10.0.0.1' // what a proxied request's socket peer looks like
const SENDER = '203.0.113.7' // what the proxy says the real sender is

const req = (headers: Record<string, string | string[] | undefined>, ip = SOCKET) => ({
  headers,
  ip,
})

const trusted = (extra: Record<string, string> = {}) => ({
  [PROXY_TRUST_HEADER]: SECRET,
  ...extra,
})

beforeEach(() => {
  envMock.PROXY_TRUST_SECRET = SECRET
})

describe('clientIp', () => {
  it('takes the forwarded address when the proxy proves itself', () => {
    expect(clientIp(req(trusted({ 'x-client-ip': SENDER })))).toBe(SENDER)
  })

  it('ignores the forwarded address when no secret is presented', () => {
    expect(clientIp(req({ 'x-client-ip': SENDER }))).toBe(SOCKET)
  })

  it('ignores it when the secret is wrong', () => {
    expect(
      clientIp(req({ [PROXY_TRUST_HEADER]: 'b'.repeat(64), 'x-client-ip': SENDER })),
    ).toBe(SOCKET)
  })

  // A wrong secret of a DIFFERENT length is the case that would throw rather
  // than return false if the length check were removed — timingSafeEqual
  // raises on a length mismatch. A throw here 500s a consent write.
  it('ignores a wrong secret of a different length without throwing', () => {
    expect(() => clientIp(req({ [PROXY_TRUST_HEADER]: 'short', 'x-client-ip': SENDER }))).not.toThrow()
    expect(clientIp(req({ [PROXY_TRUST_HEADER]: 'short', 'x-client-ip': SENDER }))).toBe(SOCKET)
  })

  // FAILS CLOSED. An unconfigured API must not start believing headers just
  // because nobody set a secret — that is the deployment where it matters most.
  it('ignores the forwarded address when the API has no secret configured', () => {
    envMock.PROXY_TRUST_SECRET = undefined
    expect(clientIp(req(trusted({ 'x-client-ip': SENDER })))).toBe(SOCKET)
  })

  it('falls back when a trusted proxy forwards no address at all', () => {
    expect(clientIp(req(trusted()))).toBe(SOCKET)
  })

  // Node gives an array for a repeated header. Taking `[0]` would let a caller
  // append a second copy and pick which one wins; a non-string is simply not an
  // address.
  it('ignores a repeated x-client-ip rather than picking one', () => {
    expect(clientIp(req(trusted({}) as never, SOCKET))).toBe(SOCKET)
    expect(
      clientIp({ headers: { ...trusted(), 'x-client-ip': [SENDER, '1.2.3.4'] }, ip: SOCKET }),
    ).toBe(SOCKET)
  })

  it('ignores an empty forwarded address', () => {
    expect(clientIp(req(trusted({ 'x-client-ip': '' })))).toBe(SOCKET)
  })
})

describe('clientUserAgent', () => {
  it('takes the forwarded UA when the proxy proves itself', () => {
    expect(clientUserAgent(req(trusted({ 'x-client-ua': 'Safari/1', 'user-agent': 'node' })))).toBe(
      'Safari/1',
    )
  })

  it('falls back to this request\'s own UA when it does not', () => {
    expect(clientUserAgent(req({ 'x-client-ua': 'Safari/1', 'user-agent': 'node' }))).toBe('node')
  })

  it('is null when there is no UA anywhere', () => {
    expect(clientUserAgent(req({}))).toBeNull()
  })
})

describe('isTrustedProxy', () => {
  it('is true only for the exact secret', () => {
    expect(isTrustedProxy(trusted())).toBe(true)
    expect(isTrustedProxy({ [PROXY_TRUST_HEADER]: SECRET.toUpperCase() })).toBe(false)
    expect(isTrustedProxy({ [PROXY_TRUST_HEADER]: SECRET + 'x' })).toBe(false)
    expect(isTrustedProxy({})).toBe(false)
  })
})
