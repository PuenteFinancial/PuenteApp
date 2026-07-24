import { describe, it, expect, afterEach, vi } from 'vitest'
import { resolveSendMoneyFlag, appEnv, isProductionEnv } from './flags'

describe('resolveSendMoneyFlag', () => {
  it('honors PostHog’s explicit boolean regardless of environment', () => {
    expect(resolveSendMoneyFlag(true, true)).toBe(true)
    expect(resolveSendMoneyFlag(true, false)).toBe(true)
    expect(resolveSendMoneyFlag(false, false)).toBe(false)
    expect(resolveSendMoneyFlag(false, true)).toBe(false)
  })

  it('fails safe when PostHog can’t answer: hidden in production, visible elsewhere', () => {
    expect(resolveSendMoneyFlag(undefined, true)).toBe(false) // production → hidden
    expect(resolveSendMoneyFlag(undefined, false)).toBe(true) // dev/preview/staging → visible
  })
})

describe('appEnv', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('reports the Vercel environment when there is one', () => {
    vi.stubEnv('VERCEL_ENV', 'production')
    expect(appEnv()).toBe('production')
    // Staging is the `main` branch, which Vercel builds as a PREVIEW.
    vi.stubEnv('VERCEL_ENV', 'preview')
    expect(appEnv()).toBe('preview')
    vi.stubEnv('VERCEL_ENV', 'development')
    expect(appEnv()).toBe('development')
  })

  it('falls back to NODE_ENV off Vercel', () => {
    vi.stubEnv('VERCEL_ENV', '')
    vi.stubEnv('NODE_ENV', 'development')
    expect(appEnv()).toBe('development')
    vi.stubEnv('NODE_ENV', 'production')
    expect(appEnv()).toBe('production')
  })

  it('treats only a Vercel Production deployment as real production', () => {
    // The whole point: NODE_ENV is 'production' for every Vercel build, so
    // staging must NOT read as production.
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('VERCEL_ENV', 'preview')
    expect(isProductionEnv()).toBe(false)
    vi.stubEnv('VERCEL_ENV', 'production')
    expect(isProductionEnv()).toBe(true)
  })
})
