import { describe, it, expect } from 'vitest'
import crypto from 'node:crypto'
import { getFundingProcessor } from './index.js'

// setup.ts provides MOCK_FUNDING_WEBHOOK_SECRET for tests
const SECRET = process.env.MOCK_FUNDING_WEBHOOK_SECRET!

const processor = getFundingProcessor()

const eventBody = (overrides: Record<string, unknown> = {}) =>
  Buffer.from(
    JSON.stringify({
      id: 'evt_123',
      type: 'funding_succeeded',
      data: {
        transfer_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        payment_ref: 'mockpay_abc',
      },
      ...overrides,
    }),
  )

const sign = (body: Buffer, t: number = Date.now(), secret: string = SECRET) =>
  `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${body.toString('utf8')}`).digest('hex')}`

describe('funding factory', () => {
  it('returns the mock processor for FUNDING_PROCESSOR=mock', () => {
    expect(processor.provider).toBe('mock')
  })
})

describe('mock initiateFunding', () => {
  it('returns processor-neutral ACH details with a fresh payment ref', async () => {
    const a = await processor.initiateFunding({
      transferId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      userId: 'user-1',
      totalAmountMinor: 20000,
      currency: 'USD',
    })
    const b = await processor.initiateFunding({
      transferId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      userId: 'user-1',
      totalAmountMinor: 20000,
      currency: 'USD',
    })
    expect(a).toMatchObject({ provider: 'mock', method: 'ach', clientFields: {} })
    expect(a.paymentRef).toMatch(/^mockpay_/)
    expect(a.paymentRef).not.toBe(b.paymentRef)
  })
})

describe('mock verifySignature', () => {
  it('accepts a valid signature', () => {
    const body = eventBody()
    expect(processor.verifySignature(body, sign(body))).toBe(true)
  })

  it('rejects a wrong secret, tampered body, stale timestamp, and malformed headers — without throwing', () => {
    const body = eventBody()
    expect(processor.verifySignature(body, sign(body, Date.now(), 'wrong-secret-wrong'))).toBe(false)
    expect(processor.verifySignature(Buffer.from('{"tampered":1}'), sign(body))).toBe(false)
    expect(processor.verifySignature(body, sign(body, Date.now() - 6 * 60 * 1000))).toBe(false)
    for (const header of ['', 'garbage', 't=abc,v1=zz', 'v1=aa', `t=${Date.now()}`, 't=,v1=']) {
      expect(processor.verifySignature(body, header)).toBe(false)
    }
  })
})

describe('mock parseEvent', () => {
  it('normalizes each event type', () => {
    for (const type of [
      'funding_succeeded',
      'funding_failed',
      'funding_cleared',
      'funding_reversed',
    ] as const) {
      const parsed = processor.parseEvent(eventBody({ type }))
      expect(parsed).toEqual({
        eventId: 'evt_123',
        type,
        transferRef: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        paymentRef: 'mockpay_abc',
        reason: undefined,
      })
    }
  })

  it('carries the failure reason through', () => {
    const parsed = processor.parseEvent(
      eventBody({ type: 'funding_failed', data: { transfer_id: 'x', payment_ref: 'y', reason: 'R01' } }),
    )
    expect(parsed?.reason).toBe('R01')
  })

  it('returns null for garbage, unknown types, and missing fields', () => {
    expect(processor.parseEvent(Buffer.from('not json'))).toBeNull()
    expect(processor.parseEvent(eventBody({ type: 'payment.exploded' }))).toBeNull()
    expect(processor.parseEvent(Buffer.from(JSON.stringify({ id: 'evt', type: 'funding_succeeded' })))).toBeNull()
    expect(
      processor.parseEvent(
        Buffer.from(JSON.stringify({ type: 'funding_succeeded', data: { transfer_id: 'x', payment_ref: 'y' } })),
      ),
    ).toBeNull()
  })
})
