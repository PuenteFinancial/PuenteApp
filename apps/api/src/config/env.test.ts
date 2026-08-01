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

describe('OPS_ADMIN_USER_IDS allowlist (slice 8.5-v1)', () => {
  it('defaults to the empty set — fail closed, nobody is an ops admin', () => {
    const parsed = envSchemaWithRules.safeParse(base)
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.OPS_ADMIN_USER_IDS).toEqual(new Set())
  })

  it('parses a comma-separated list, trimming whitespace and dropping empties', () => {
    const parsed = envSchemaWithRules.safeParse({
      ...base,
      OPS_ADMIN_USER_IDS: ' 11111111-2222-4333-8444-555555555555 ,, 99999999-8888-4777-8666-555555555554 ',
    })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.OPS_ADMIN_USER_IDS).toEqual(
      new Set(['11111111-2222-4333-8444-555555555555', '99999999-8888-4777-8666-555555555554']),
    )
  })

  it('an all-whitespace value still parses to the empty set (fail closed)', () => {
    const parsed = envSchemaWithRules.safeParse({ ...base, OPS_ADMIN_USER_IDS: ' , ' })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.OPS_ADMIN_USER_IDS.size).toBe(0)
  })
})

describe('OPS_WRITE_ENABLED write capability (slice 8.5-v1.1)', () => {
  it('defaults to false — fail closed, the write route does not exist', () => {
    const parsed = envSchemaWithRules.safeParse(base)
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.OPS_WRITE_ENABLED).toBe(false)
  })

  it("parses only the exact strings 'true' and 'false'", () => {
    const on = envSchemaWithRules.safeParse({ ...base, OPS_WRITE_ENABLED: 'true' })
    expect(on.success).toBe(true)
    expect(on.success && on.data.OPS_WRITE_ENABLED).toBe(true)

    const off = envSchemaWithRules.safeParse({ ...base, OPS_WRITE_ENABLED: 'false' })
    expect(off.success).toBe(true)
    expect(off.success && off.data.OPS_WRITE_ENABLED).toBe(false)

    // z.coerce.boolean() would parse '1' (and even 'false') as true — the
    // enum-transform refuses anything that is not the exact literal.
    const junk = envSchemaWithRules.safeParse({ ...base, OPS_WRITE_ENABLED: '1' })
    expect(junk.success).toBe(false)
  })
})

describe('stuck-transfer dwell knobs (slice-8 O1)', () => {
  it('applies the hard defaults so the pager is armed even when unset', () => {
    const parsed = envSchemaWithRules.safeParse(base)
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.STUCK_FUNDED_AFTER_MINUTES).toBe(15)
    expect(parsed.data.STUCK_SUBMITTED_AFTER_MINUTES).toBe(30)
    expect(parsed.data.STUCK_IN_FLIGHT_AFTER_MINUTES).toBe(60)
    expect(parsed.data.STUCK_UNDER_REVIEW_AFTER_HOURS).toBe(24)
  })

  it('coerces string overrides and refuses the page-everything zero', () => {
    const tuned = envSchemaWithRules.safeParse({ ...base, STUCK_FUNDED_AFTER_MINUTES: '5' })
    expect(tuned.success).toBe(true)
    expect(tuned.success && tuned.data.STUCK_FUNDED_AFTER_MINUTES).toBe(5)

    const zero = envSchemaWithRules.safeParse({ ...base, STUCK_FUNDED_AFTER_MINUTES: '0' })
    expect(zero.success).toBe(false)
  })
})
