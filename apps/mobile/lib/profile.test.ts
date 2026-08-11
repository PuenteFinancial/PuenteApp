import { describe, it, expect } from 'vitest'
import { isValidProfile, toProfilePayload, NAME_MAX_LENGTH, type ProfileDraft } from './profile'

function draft(overrides: Partial<ProfileDraft> = {}): ProfileDraft {
  return { firstName: 'Ana', lastName: 'Ruiz', email: 'ana@example.com', ...overrides }
}

// These rules must stay in step with the PATCH /v1/users/me schema in
// apps/api/src/routes/v1/users.ts. Drift in either direction is a bug the user
// experiences: too strict here blocks a signup the server would have accepted,
// too lax produces a 400 the form can only report generically.
describe('isValidProfile', () => {
  it('accepts a complete profile', () => {
    expect(isValidProfile(draft())).toBe(true)
  })

  it.each([['firstName'], ['lastName']] as const)('rejects an empty %s', (field) => {
    expect(isValidProfile(draft({ [field]: '' }))).toBe(false)
  })

  it.each([['firstName'], ['lastName']] as const)('rejects a whitespace-only %s', (field) => {
    // The API trims before storing, so "   " would satisfy a naive length
    // check here and then fail minLength: 1 on the server.
    expect(isValidProfile(draft({ [field]: '   ' }))).toBe(false)
  })

  it('accepts a name at the length limit and rejects one past it', () => {
    expect(isValidProfile(draft({ firstName: 'a'.repeat(NAME_MAX_LENGTH) }))).toBe(true)
    expect(isValidProfile(draft({ firstName: 'a'.repeat(NAME_MAX_LENGTH + 1) }))).toBe(false)
  })

  it.each([
    ['no @', 'anaexample.com'],
    ['nothing before the @', '@example.com'],
    ['nothing after the @', 'ana@'],
    ['no dot in the domain', 'ana@example'],
    ['an internal space', 'an a@example.com'],
    ['empty', ''],
  ])('rejects an email with %s', (_case, email) => {
    expect(isValidProfile(draft({ email }))).toBe(false)
  })

  it.each([
    ['a plus tag', 'ana+puente@example.com'],
    ['a subdomain', 'ana@mail.example.com'],
    ['a hyphenated domain', 'ana@my-domain.com'],
    ['a long TLD', 'ana@example.solutions'],
  ])('accepts a real-world address with %s', (_case, email) => {
    // Being too strict here is the expensive failure — it blocks signup
    // outright, while being too lax costs one 400 the form already handles.
    expect(isValidProfile(draft({ email }))).toBe(true)
  })

  it('ignores surrounding whitespace when judging validity', () => {
    expect(isValidProfile(draft({ firstName: '  Ana  ', email: '  ana@example.com  ' }))).toBe(true)
  })
})

describe('toProfilePayload', () => {
  it('trims every field, so the value judged is the value stored', () => {
    expect(
      toProfilePayload({ firstName: '  Ana ', lastName: ' Ruiz  ', email: ' ana@example.com ' }),
    ).toEqual({ firstName: 'Ana', lastName: 'Ruiz', email: 'ana@example.com' })
  })
})
