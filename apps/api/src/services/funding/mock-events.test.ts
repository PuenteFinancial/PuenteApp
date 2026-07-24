import { describe, it, expect, beforeEach, vi } from 'vitest'

// The signer and the verifier must agree, so the real MockFundingProcessor is
// the assertion target: a round-trip test is what actually proves the endpoint
// and the script can't drift from the route that validates them.
// Reuses the same dummy value as src/test/setup.ts on purpose. A higher-entropy
// placeholder (e.g. one with a long digit run) trips gitleaks' generic-api-key
// rule and fails the required Gitleaks check, even though nothing here is real.
const TEST_SECRET = 'mock_funding_secret_test'
const OTHER_SECRET = 'mock_funding_secret_other'

vi.mock('../../config/env.js', () => ({
  env: { MOCK_FUNDING_WEBHOOK_SECRET: 'mock_funding_secret_test' },
}))

const { buildMockFundingEvent } = await import('./mock-events.js')
const { MockFundingProcessor } = await import('./mock.js')

const SECRET = TEST_SECRET
const TRANSFER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'

describe('buildMockFundingEvent', () => {
  let processor: InstanceType<typeof MockFundingProcessor>

  beforeEach(() => {
    processor = new MockFundingProcessor()
  })

  it('produces a signature the mock processor verifies', () => {
    const { body, signature } = buildMockFundingEvent({
      transferId: TRANSFER_ID,
      type: 'funding_succeeded',
      secret: SECRET,
    })

    expect(processor.verifySignature(Buffer.from(body, 'utf8'), signature)).toBe(true)
  })

  it('produces a payload the mock processor parses into the expected event', () => {
    const { body } = buildMockFundingEvent({
      transferId: TRANSFER_ID,
      type: 'funding_succeeded',
      secret: SECRET,
      paymentRef: 'mockpay_from_confirm',
      eventId: 'evt_fixed',
    })

    expect(processor.parseEvent(Buffer.from(body, 'utf8'))).toEqual({
      eventId: 'evt_fixed',
      type: 'funding_succeeded',
      transferRef: TRANSFER_ID,
      paymentRef: 'mockpay_from_confirm',
    })
  })

  it('carries the reason through on a failure event', () => {
    const { body } = buildMockFundingEvent({
      transferId: TRANSFER_ID,
      type: 'funding_failed',
      secret: SECRET,
      reason: 'R01',
    })

    expect(processor.parseEvent(Buffer.from(body, 'utf8'))?.reason).toBe('R01')
  })

  it('mints a payment ref when none is supplied', () => {
    const { body } = buildMockFundingEvent({
      transferId: TRANSFER_ID,
      type: 'funding_succeeded',
      secret: SECRET,
    })

    expect(processor.parseEvent(Buffer.from(body, 'utf8'))?.paymentRef).toMatch(/^mockpay_/)
  })

  it('signs the body VERBATIM — re-serializing the JSON breaks verification', () => {
    // Guards the one way a caller can silently invalidate every event: parsing
    // the body and re-stringifying it (key order / whitespace) before POSTing.
    const { body, signature } = buildMockFundingEvent({
      transferId: TRANSFER_ID,
      type: 'funding_succeeded',
      secret: SECRET,
    })
    const reserialized = JSON.stringify({ ...JSON.parse(body), extra: 1 })

    expect(processor.verifySignature(Buffer.from(reserialized, 'utf8'), signature)).toBe(false)
  })

  it('rejects verification under the wrong secret', () => {
    const { body, signature } = buildMockFundingEvent({
      transferId: TRANSFER_ID,
      type: 'funding_succeeded',
      secret: OTHER_SECRET,
    })

    expect(processor.verifySignature(Buffer.from(body, 'utf8'), signature)).toBe(false)
  })

  it('is rejected once the timestamp falls outside the freshness window', () => {
    const { body, signature } = buildMockFundingEvent({
      transferId: TRANSFER_ID,
      type: 'funding_succeeded',
      secret: SECRET,
      timestamp: Date.now() - 6 * 60 * 1000,
    })

    expect(processor.verifySignature(Buffer.from(body, 'utf8'), signature)).toBe(false)
  })
})
