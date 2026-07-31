import { describe, it, expect, afterEach } from 'vitest'
import { internalApiUrl } from './apiBaseUrl'

const original = process.env.INTERNAL_API_URL

afterEach(() => {
  if (original === undefined) delete process.env.INTERNAL_API_URL
  else process.env.INTERNAL_API_URL = original
})

describe('internalApiUrl', () => {
  it('returns a well-formed https URL unchanged', () => {
    process.env.INTERNAL_API_URL = 'https://puenteapi-production.up.railway.app'
    expect(internalApiUrl()).toBe('https://puenteapi-production.up.railway.app')
  })

  it('allows http for local development', () => {
    process.env.INTERNAL_API_URL = 'http://localhost:3001'
    expect(internalApiUrl()).toBe('http://localhost:3001')
  })

  it('throws when unset', () => {
    delete process.env.INTERNAL_API_URL
    expect(() => internalApiUrl()).toThrow(/not configured/)
  })

  // The production incident: a bare host, scheme dropped when copied out of a
  // hosting dashboard. Presence checks pass; fetch then dies with an opaque
  // "Failed to parse URL" at request time.
  it('rejects a bare host with no scheme, and names the offending value', () => {
    process.env.INTERNAL_API_URL = 'puenteapi-production.up.railway.app'
    expect(() => internalApiUrl()).toThrow(/not an absolute URL/)
    expect(() => internalApiUrl()).toThrow(/puenteapi-production\.up\.railway\.app/)
  })

  it('rejects a protocol-relative URL', () => {
    process.env.INTERNAL_API_URL = '//puenteapi-production.up.railway.app'
    expect(() => internalApiUrl()).toThrow(/not an absolute URL/)
  })

  it('rejects a non-http scheme', () => {
    process.env.INTERNAL_API_URL = 'ftp://puenteapi-production.up.railway.app'
    expect(() => internalApiUrl()).toThrow(/must use http or https/)
  })

  it('strips trailing slashes so path concatenation cannot double up', () => {
    process.env.INTERNAL_API_URL = 'https://api.example.com//'
    expect(internalApiUrl()).toBe('https://api.example.com')
  })
})
