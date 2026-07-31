import { describe, it, expect } from 'vitest'
import { envSchemaWithRules } from './env.js'

// The minimum viable environment — mirrors what test/setup.ts provides.
const base = {
  SUPABASE_URL: 'https://test-project.supabase.co',
  SUPABASE_SECRET_KEY: 'sb_secret_test',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test',
  SUPABASE_JWKS_URL: 'https://test-project.supabase.co/auth/v1/.well-known/jwks.json',
  BRIDGE_API_KEY: 'bridge_test_key',
  DETAILS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
}

describe('FUNDING_PROCESSOR=stripe env refinement', () => {
  it('defaults to mock with no stripe keys required', () => {
    const parsed = envSchemaWithRules.safeParse(base)
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.FUNDING_PROCESSOR).toBe('mock')
  })

  it('refuses a stripe selection missing all three keys, naming each one', () => {
    const parsed = envSchemaWithRules.safeParse({ ...base, FUNDING_PROCESSOR: 'stripe' })
    expect(parsed.success).toBe(false)
    const fields = parsed.success ? {} : parsed.error.flatten().fieldErrors
    expect(fields).toHaveProperty('STRIPE_SECRET_KEY')
    expect(fields).toHaveProperty('STRIPE_WEBHOOK_SECRET')
    expect(fields).toHaveProperty('STRIPE_PUBLISHABLE_KEY')
  })

  it('refuses a stripe selection missing just the webhook + publishable keys', () => {
    const parsed = envSchemaWithRules.safeParse({
      ...base,
      FUNDING_PROCESSOR: 'stripe',
      STRIPE_SECRET_KEY: 'sk_test_x',
    })
    expect(parsed.success).toBe(false)
    const fields = parsed.success ? {} : parsed.error.flatten().fieldErrors
    expect(fields).not.toHaveProperty('STRIPE_SECRET_KEY')
    expect(fields).toHaveProperty('STRIPE_WEBHOOK_SECRET')
    expect(fields).toHaveProperty('STRIPE_PUBLISHABLE_KEY')
  })

  it('accepts a fully-keyed stripe selection and applies the timeout default + bounds', () => {
    const ok = envSchemaWithRules.safeParse({
      ...base,
      FUNDING_PROCESSOR: 'stripe',
      STRIPE_SECRET_KEY: 'sk_test_x',
      STRIPE_WEBHOOK_SECRET: 'whsec_x',
      STRIPE_PUBLISHABLE_KEY: 'pk_test_x',
    })
    expect(ok.success).toBe(true)
    expect(ok.success && ok.data.STRIPE_TIMEOUT_SECONDS).toBe(15)

    const outOfBounds = envSchemaWithRules.safeParse({
      ...base,
      FUNDING_PROCESSOR: 'stripe',
      STRIPE_SECRET_KEY: 'sk_test_x',
      STRIPE_WEBHOOK_SECRET: 'whsec_x',
      STRIPE_PUBLISHABLE_KEY: 'pk_test_x',
      STRIPE_TIMEOUT_SECONDS: '600',
    })
    expect(outOfBounds.success).toBe(false)
  })

  it('keeps mock selections free to omit the mock secret (absence IS the prod lock, not an error)', () => {
    const parsed = envSchemaWithRules.safeParse({ ...base, FUNDING_PROCESSOR: 'mock' })
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.MOCK_FUNDING_WEBHOOK_SECRET).toBeUndefined()
  })
})
