import { describe, it, expect } from 'vitest'
import { bookRefFor } from './book.js'

describe('bookRefFor', () => {
  it('is an 8-character hex fingerprint', () => {
    expect(bookRefFor('https://namdkmsmdkmdffgscqgd.supabase.co')).toMatch(/^[0-9a-f]{8}$/)
  })

  it('ignores scheme, port, path and trailing slash — the HOST is the book', () => {
    const ref = bookRefFor('https://proj.supabase.co')
    expect(bookRefFor('http://proj.supabase.co')).toBe(ref)
    expect(bookRefFor('https://proj.supabase.co/')).toBe(ref)
    expect(bookRefFor('https://PROJ.supabase.co')).toBe(ref)
    expect(bookRefFor('https://proj.supabase.co:8443/rest/v1')).toBe(ref)
  })

  it('separates two databases', () => {
    expect(bookRefFor('https://staging.supabase.co')).not.toBe(bookRefFor('http://127.0.0.1:54321'))
  })

  // Not a theoretical pair: apps/api/.env.e2e.local uses 127.0.0.1 and a
  // developer may just as well type localhost. Both are "not the deployed
  // book", which is the only distinction this ref has to make.
  it('treats 127.0.0.1 and localhost as different books, which is harmless', () => {
    expect(bookRefFor('http://127.0.0.1:54321')).not.toBe(bookRefFor('http://localhost:54321'))
  })

  it('falls back to the raw value when it is not a URL', () => {
    expect(bookRefFor('not a url')).toMatch(/^[0-9a-f]{8}$/)
    expect(bookRefFor('not a url')).toBe(bookRefFor('  NOT A URL  '))
  })
})
