import { describe, it, expect, vi, beforeEach } from 'vitest'

// Audit 2026-09-02 corner 1: the row says which rail funded it; the process
// value is only the fallback for rows stamped before the column existed.

const envMock = vi.hoisted(() => ({
  FUNDING_PROCESSOR: 'mock' as string,
  STRIPE_SECRET_KEY: undefined as string | undefined,
  STRIPE_WEBHOOK_SECRET: undefined as string | undefined,
  STRIPE_PUBLISHABLE_KEY: undefined as string | undefined,
  MOCK_FUNDING_WEBHOOK_SECRET: 'x',
}))
vi.mock('../../config/env.js', () => ({ env: envMock }))

const { getFundingProcessor, processorFor, processorNameFor } = await import('./index.js')

beforeEach(() => {
  envMock.FUNDING_PROCESSOR = 'mock'
})

describe('processorNameFor', () => {
  it('prefers the row, falls back to the process for a null or missing stamp', () => {
    expect(processorNameFor({ funding_processor: 'manual' })).toBe('manual')
    expect(processorNameFor({ funding_processor: null })).toBe('mock')
    expect(processorNameFor({})).toBe('mock')
    envMock.FUNDING_PROCESSOR = 'stripe_crypto'
    expect(processorNameFor({ funding_processor: null })).toBe('stripe_crypto')
  })
})

describe('processorFor', () => {
  it('returns the memoized process instance when the row matches the process rail', () => {
    const viaProcess = getFundingProcessor()
    expect(processorFor({ funding_processor: 'mock' })).toBe(viaProcess)
    expect(processorFor({ funding_processor: null })).toBe(viaProcess)
  })

  it('builds (and memoizes) a different rail for a row stamped under it', () => {
    const manual = processorFor({ funding_processor: 'manual' })
    expect(manual.provider).toBe('manual')
    expect(manual).not.toBe(getFundingProcessor())
    expect(processorFor({ funding_processor: 'manual' })).toBe(manual)
  })

  it('never throws on an unknown stamp — the column has no CHECK — and falls back', () => {
    expect(processorFor({ funding_processor: 'not_a_rail' })).toBe(getFundingProcessor())
  })
})
