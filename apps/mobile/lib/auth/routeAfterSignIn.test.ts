import { describe, it, expect } from 'vitest'
import { routeAfterSignIn } from './routeAfterSignIn'
import type { MeResponse } from './types'

function me(overrides: Partial<MeResponse> = {}): MeResponse {
  return {
    id: 'user-1',
    firstName: 'Ana',
    lastName: 'Ruiz',
    email: 'ana@example.com',
    kycStatus: 'approved',
    bridgeCustomerId: null,
    ...overrides,
  }
}

// This table must stay in step with apps/web/app/continue/page.tsx — a user
// who signs in on web and on mobile has to land in the same place.
describe('routeAfterSignIn', () => {
  it('sends a fully-onboarded approved user to the app', () => {
    expect(routeAfterSignIn({ status: 200, body: me() })).toBe('/(app)/home')
  })

  it('sends a 404 (missing users row) to the profile form, not back to auth', () => {
    // The verify handler self-heals the row on next sign-in; the profile form
    // is the useful destination meanwhile.
    expect(routeAfterSignIn({ status: 404, body: null })).toBe('/(app)/profile')
  })

  it.each([
    ['firstName', { firstName: null }],
    ['lastName', { lastName: null }],
    ['email', { email: null }],
  ])('sends a user missing %s to the profile form', (_field, patch) => {
    expect(routeAfterSignIn({ status: 200, body: me(patch) })).toBe('/(app)/profile')
  })

  it('routes each kycStatus to its screen', () => {
    expect(routeAfterSignIn({ status: 200, body: me({ kycStatus: 'not_started' }) })).toBe('/(app)/kyc')
    expect(routeAfterSignIn({ status: 200, body: me({ kycStatus: 'rejected' }) })).toBe('/(app)/rejected')
    expect(routeAfterSignIn({ status: 200, body: me({ kycStatus: 'pending' }) })).toBe('/(app)/pending')
    expect(routeAfterSignIn({ status: 200, body: me({ kycStatus: 'manual_review' }) })).toBe('/(app)/pending')
  })

  it('holds an unrecognized kycStatus at pending rather than crashing', () => {
    // A status added server-side must degrade to a holding screen; throwing
    // here would take the app down on a deploy the client did not ship with.
    expect(routeAfterSignIn({ status: 200, body: me({ kycStatus: 'brand_new_state' }) })).toBe(
      '/(app)/pending',
    )
  })

  it('sends an unusable session back to auth', () => {
    expect(routeAfterSignIn({ status: 401, body: null })).toBe('/(auth)')
    expect(routeAfterSignIn({ status: 500, body: null })).toBe('/(auth)')
    // 200 with no body is a contract violation, not a signed-in user.
    expect(routeAfterSignIn({ status: 200, body: null })).toBe('/(auth)')
  })

  it('checks profile completeness BEFORE kyc status', () => {
    // Mirrors continue/page.tsx ordering: an approved user with no name still
    // goes to the profile form. Reversing these would let someone reach the
    // dashboard with an empty profile.
    expect(
      routeAfterSignIn({ status: 200, body: me({ firstName: null, kycStatus: 'approved' }) }),
    ).toBe('/(app)/profile')
  })
})
