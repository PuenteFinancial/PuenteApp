import { describe, it, expect } from 'vitest'
import { isValidState, parseTosReturn, stateMatches } from './kyc'

const NONCE = 'a1b2c3d4e5f6g7h8'

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
  it('accepts the nonce it issued', () => {
    expect(stateMatches(NONCE, NONCE)).toBe(true)
  })

  it('rejects a different nonce', () => {
    // This is the whole point: a link the app did not initiate carries a nonce
    // it never stored, so the agreement id is never exchanged.
    expect(stateMatches('z1b2c3d4e5f6g7h8', NONCE)).toBe(false)
  })

  it('rejects when nothing was stored', () => {
    // Cold start with no flow in progress — any return is unsolicited.
    expect(stateMatches(NONCE, null)).toBe(false)
  })

  it('rejects a prefix or an extension of the stored nonce', () => {
    expect(stateMatches(NONCE.slice(0, 8), NONCE)).toBe(false)
    expect(stateMatches(`${NONCE}extra`, NONCE)).toBe(false)
  })
})
