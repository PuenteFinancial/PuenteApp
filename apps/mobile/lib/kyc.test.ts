import { describe, it, expect } from 'vitest'
import {
  isValidState,
  KYC_STATE_TTL_MS,
  parseStoredState,
  parseTosReturn,
  routeAfterKycReturn,
  serializeState,
  stateMatches,
} from './kyc'

const NONCE = 'a1b2c3d4e5f6g7h8'
const T0 = 1_700_000_000_000
const fresh = (state = NONCE, issuedAt = T0) => ({ state, issuedAt })

describe('isValidState', () => {
  it('accepts a UUID, which is what the app mints', () => {
    expect(isValidState('9fc02bc4-9d8f-4820-bd84-0a8455f0a617')).toBe(true)
  })

  it.each([
    ['too short to be unguessable', 'abcdefghijklmno'],
    ['over the API limit', 'a'.repeat(65)],
    ['a query separator', 'abcdefghijklmnop&x=1'],
    ['a fragment', 'abcdefghijklmnop#x'],
    ['a path separator', 'abcdefgh/ijklmnop'],
    ['empty', ''],
  ])('rejects %s', (_case, value) => {
    // Must stay in step with the pattern on POST /v1/users/me/tos-link — the
    // API is the control, this is the early warning.
    expect(isValidState(value)).toBe(false)
  })
})

describe('parseTosReturn', () => {
  it('reads state and signed_agreement_id from a genuine return', () => {
    expect(
      parseTosReturn(`puente://kyc/tos-return?state=${NONCE}&signed_agreement_id=agr-123`),
    ).toEqual({ state: NONCE, signedAgreementId: 'agr-123' })
  })

  it('does not care what order Bridge appends the params in', () => {
    expect(
      parseTosReturn(`puente://kyc/tos-return?signed_agreement_id=agr-123&state=${NONCE}`),
    ).toEqual({ state: NONCE, signedAgreementId: 'agr-123' })
  })

  it.each([
    ['no signed_agreement_id', `puente://kyc/tos-return?state=${NONCE}`],
    ['no state', 'puente://kyc/tos-return?signed_agreement_id=agr-123'],
    ['neither', 'puente://kyc/tos-return'],
    ['an empty state', 'puente://kyc/tos-return?state=&signed_agreement_id=agr-123'],
    ['a malformed state', 'puente://kyc/tos-return?state=nope&signed_agreement_id=agr-123'],
    ['not a URL at all', 'not a url'],
  ])('returns null for a return with %s', (_case, url) => {
    expect(parseTosReturn(url)).toBeNull()
  })
})

describe('stateMatches', () => {
  it('accepts the nonce it issued, within the window', () => {
    expect(stateMatches(NONCE, fresh(), T0 + 1000)).toBe(true)
  })

  it('rejects a different nonce', () => {
    // This is the whole point: a link the app did not initiate carries a nonce
    // it never stored, so the agreement id is never exchanged.
    expect(stateMatches('z1b2c3d4e5f6g7h8', fresh(), T0)).toBe(false)
  })

  it('rejects when nothing was stored', () => {
    // Cold start with no flow in progress — any return is unsolicited.
    expect(stateMatches(NONCE, null, T0)).toBe(false)
  })

  it('rejects a prefix or an extension of the stored nonce', () => {
    expect(stateMatches(NONCE.slice(0, 8), fresh(), T0)).toBe(false)
    expect(stateMatches(`${NONCE}extra`, fresh(), T0)).toBe(false)
  })

  it('rejects the right nonce once it has expired', () => {
    // The return leg is a GET, so the nonce rides in a URL that Railway's edge
    // logs. Expiry is what stops one read out of a log tomorrow from being
    // usable against a flow the user abandoned today.
    expect(stateMatches(NONCE, fresh(), T0 + KYC_STATE_TTL_MS + 1)).toBe(false)
  })

  it('accepts right up to the boundary', () => {
    expect(stateMatches(NONCE, fresh(), T0 + KYC_STATE_TTL_MS)).toBe(true)
  })

  it('rejects a record issued in the future', () => {
    // Clock moved backwards, or a tampered record. Either way it is not
    // something this app issued a moment ago.
    expect(stateMatches(NONCE, fresh(NONCE, T0 + 60_000), T0)).toBe(false)
  })
})

describe('serializeState / parseStoredState', () => {
  it('round-trips', () => {
    expect(parseStoredState(serializeState(NONCE, T0))).toEqual({ state: NONCE, issuedAt: T0 })
  })

  it.each([
    ['nothing stored', null],
    ['not JSON', 'not json'],
    ['a bare string, the pre-expiry format', `"${NONCE}"`],
    ['no issuedAt', JSON.stringify({ state: NONCE })],
    ['a non-numeric issuedAt', JSON.stringify({ state: NONCE, issuedAt: 'soon' })],
    ['a non-finite issuedAt', JSON.stringify({ state: NONCE, issuedAt: null })],
  ])('returns null for %s', (_case, raw) => {
    // Unreadable means "no flow in progress", which is the safe reading — an
    // upgrade from the old bare-string format lands here and simply fails the
    // one in-flight return rather than accepting it unchecked.
    expect(parseStoredState(raw)).toBeNull()
  })
})

// Must stay in step with apps/web/app/onboarding/kyc/return/page.tsx.
describe('routeAfterKycReturn', () => {
  it('sends an approved user home', () => {
    expect(routeAfterKycReturn('approved')).toBe('/(app)/home')
  })

  it('sends a rejected user to the rejected screen', () => {
    expect(routeAfterKycReturn('rejected')).toBe('/(app)/rejected')
  })

  it.each([['not_started'], ['pending'], ['manual_review'], ['some_new_state']])(
    'holds %s at pending rather than anywhere else',
    (status) => {
      expect(routeAfterKycReturn(status)).toBe('/(app)/pending')
    },
  )

  it('holds not_started at pending — the case routeAfterSignIn gets right and this must not', () => {
    // kyc-link records only bridge_customer_id, so kyc_status is still
    // not_started when the user dismisses Persona. routeAfterSignIn maps that
    // to the KYC screen, which would drop them back onto the screen they just
    // completed. This is the entire reason the two functions differ.
    expect(routeAfterKycReturn('not_started')).toBe('/(app)/pending')
  })

  it.each([[null], [undefined]])('treats a missing status as undecided', (status) => {
    expect(routeAfterKycReturn(status)).toBe('/(app)/pending')
  })
})
