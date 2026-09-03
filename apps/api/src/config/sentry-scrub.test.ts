import { describe, it, expect } from 'vitest'
import type { ErrorEvent } from '@sentry/node'
import { REDACTED, SENSITIVE_KEY, scrubEvent, scrubObject } from './sentry-scrub.js'
import { createDedupeFilter } from './sentry-dedupe.js'

// The exact values invariant test (c) feeds the relay route: if either ever
// shows up in a captured line or event, the custody rule is broken.
const DOB = '1987-03-21'
const SSN = '078-05-1120'

const relayShaped = () => ({
  dob: DOB,
  taxId: { type: 'ssn', number: SSN },
  identifying_information: [{ type: 'ssn', issuing_country: 'usa', number: SSN }],
  birth_date: DOB,
  userId: 'user-123',
  bridgeCode: 'invalid_parameters',
})

describe('SENSITIVE_KEY', () => {
  it('matches every relay-body key and the Bridge wire names', () => {
    for (const key of ['dob', 'taxId', 'tax_id', 'ssn', 'itin', 'number', 'birth_date', 'identifying_information', 'id_number', 'date_of_birth']) {
      expect(SENSITIVE_KEY.test(key), key).toBe(true)
    }
  })

  it('leaves operational keys alone', () => {
    for (const key of ['userId', 'transferId', 'bridgeCode', 'status', 'state', 'reason', 'fingerprint']) {
      expect(SENSITIVE_KEY.test(key), key).toBe(false)
    }
  })
})

describe('scrubObject', () => {
  it('redacts by key name at any depth and keeps everything else', () => {
    const out = scrubObject({ a: relayShaped(), list: [{ ssn: SSN }, 'plain'] }) as Record<string, unknown>
    const json = JSON.stringify(out)
    expect(json).not.toContain(DOB)
    expect(json).not.toContain(SSN)
    expect(json).toContain('user-123')
    expect(json).toContain('invalid_parameters')
    expect((out.a as Record<string, unknown>).dob).toBe(REDACTED)
    expect((out.list as unknown[])[1]).toBe('plain')
  })

  it('does not mutate its input', () => {
    const input = relayShaped()
    scrubObject(input)
    expect(input.dob).toBe(DOB)
    expect(input.taxId.number).toBe(SSN)
  })

  it('survives cycles and bounds depth instead of hanging', () => {
    const cyclic: Record<string, unknown> = { userId: 'u1' }
    cyclic.self = cyclic
    const out = scrubObject(cyclic) as Record<string, unknown>
    expect(out.userId).toBe('u1')
    expect(out.self).toBe(REDACTED)

    let deep: Record<string, unknown> = { ssn: SSN }
    for (let i = 0; i < 20; i++) deep = { inner: deep }
    expect(JSON.stringify(scrubObject(deep))).not.toContain(SSN)
  })

  it('keeps a shared (non-cyclic) reference readable in both places', () => {
    const shared = { transferId: 't1' }
    const out = scrubObject({ a: shared, b: shared }) as Record<string, Record<string, unknown>>
    expect(out.a!.transferId).toBe('t1')
    expect(out.b!.transferId).toBe('t1')
  })
})

describe('scrubEvent', () => {
  const event = (): ErrorEvent =>
    ({
      fingerprint: ['bridge-customer-orphan', 'user-123'],
      extra: relayShaped(),
      contexts: { relay: relayShaped(), runtime: { name: 'node' } },
      request: { url: '/v1/users/me/bridge-customer', data: JSON.stringify(relayShaped()) },
      breadcrumbs: [
        { category: 'http', data: { url: '/x', body: relayShaped() } },
        { category: 'console', message: 'hello' },
      ],
    }) as unknown as ErrorEvent

  it('redacts extra, contexts, request.data (string and object) and breadcrumb data', () => {
    const out = scrubEvent(event())
    const json = JSON.stringify(out)
    expect(json).not.toContain(DOB)
    expect(json).not.toContain(SSN)
    expect(json).not.toContain('078051120')

    const objectBody = scrubEvent({ ...event(), request: { data: relayShaped() } } as unknown as ErrorEvent)
    expect(JSON.stringify(objectBody)).not.toContain(SSN)
  })

  it('keeps the parts Sentry groups and routes on', () => {
    const out = scrubEvent(event())
    expect(out.fingerprint).toEqual(['bridge-customer-orphan', 'user-123'])
    expect(out.request?.url).toBe('/v1/users/me/bridge-customer')
    expect((out.contexts as Record<string, Record<string, unknown>>).runtime!.name).toBe('node')
    expect(out.breadcrumbs?.[1]).toEqual({ category: 'console', message: 'hello' })
    expect((out.extra as Record<string, unknown>).userId).toBe('user-123')
  })

  it('replaces a non-JSON request body whole rather than guessing', () => {
    const out = scrubEvent({ request: { data: `ssn=${SSN}` } } as unknown as ErrorEvent)
    expect(out.request?.data).toBe(REDACTED)
  })

  it('is a no-op on an event with none of those sections', () => {
    const bare = { message: 'x', exception: { values: [{ type: 'Error', value: 'boom' }] } } as ErrorEvent
    expect(scrubEvent(bare)).toEqual(bare)
  })

  it('composes with the dedupe filter: scrubbing never changes the suppression decision', () => {
    const raw = createDedupeFilter(60_000)
    const composed = createDedupeFilter(60_000)
    const e = event()
    expect(raw(e, 0)).toBe(true)
    expect(composed(scrubEvent(e), 0)).toBe(true)
    expect(raw(e, 1)).toBe(false)
    expect(composed(scrubEvent(e), 1)).toBe(false)

    // instrument.ts wiring, end to end: scrub first, then decide.
    const beforeSend = (ev: ErrorEvent, now: number) => {
      const s = scrubEvent(ev)
      return composed(s, now) ? s : null
    }
    const sent = beforeSend(event(), 100_000)
    expect(sent).not.toBeNull()
    expect(JSON.stringify(sent)).not.toContain(SSN)
  })
})
