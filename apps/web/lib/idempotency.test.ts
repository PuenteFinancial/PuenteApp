import { describe, it, expect } from 'vitest'
import { createIdempotencyKeyHolder } from './idempotency'

describe('createIdempotencyKeyHolder', () => {
  it('mints once and returns the same key across repeated take() — retries reuse the key', () => {
    let n = 0
    const holder = createIdempotencyKeyHolder(() => `key-${++n}`)
    expect(holder.take()).toBe('key-1')
    expect(holder.take()).toBe('key-1')
    expect(holder.take()).toBe('key-1')
    expect(n).toBe(1) // minted exactly once
  })

  it('peek() is null before the first take(), then reflects the held key', () => {
    const holder = createIdempotencyKeyHolder(() => 'k')
    expect(holder.peek()).toBeNull()
    holder.take()
    expect(holder.peek()).toBe('k')
  })

  it('clear() drops the key so the next take() mints a fresh one — a new logical action', () => {
    let n = 0
    const holder = createIdempotencyKeyHolder(() => `key-${++n}`)
    expect(holder.take()).toBe('key-1')
    holder.clear()
    expect(holder.peek()).toBeNull()
    expect(holder.take()).toBe('key-2') // fresh key, never reused across actions
  })

  it('defaults to crypto.randomUUID and holds a stable UUID', () => {
    const holder = createIdempotencyKeyHolder()
    const key = holder.take()
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    expect(holder.take()).toBe(key) // still stable with the real generator
  })
})
