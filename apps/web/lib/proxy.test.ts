import { describe, it, expect } from 'vitest'
import type { NextRequest } from 'next/server'
import { forwardIdempotencyKey } from './proxy'

// Minimal NextRequest stand-in: only headers.get is exercised here.
function reqWith(headers: Record<string, string>): NextRequest {
  return {
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  } as unknown as NextRequest
}

describe('forwardIdempotencyKey', () => {
  it('forwards the incoming Idempotency-Key verbatim', () => {
    expect(forwardIdempotencyKey(reqWith({ 'idempotency-key': 'a1b2-c3' }))).toEqual({
      'idempotency-key': 'a1b2-c3',
    })
  })

  it('returns an empty object when no key is present — the proxy never mints one', () => {
    expect(forwardIdempotencyKey(reqWith({}))).toEqual({})
  })
})
