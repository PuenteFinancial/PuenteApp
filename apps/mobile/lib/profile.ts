// Client-side validation for the profile form, kept out of the component so it
// tests in plain Node — same reason routeAfterSignIn is a pure function.
//
// This mirrors the API's schema (apps/api/src/routes/v1/users.ts): firstName
// and lastName are 1-100 characters, email must be a valid address. The server
// is the authority and rejects anything that slips past; this exists so the
// user finds out before a round trip, and so the submit button tells the truth
// about whether it will work.

export interface ProfileDraft {
  firstName: string
  lastName: string
  email: string
}

// The API trims before storing, so a name of only whitespace would pass a naive
// length check here and then fail `minLength: 1` server-side. Validate what the
// server will actually see.
export const NAME_MAX_LENGTH = 100

// Deliberately permissive: one @, something either side, a dot in the domain.
// Client-side email regexes that try to be RFC-complete reject real addresses,
// and the consequence of being too lax here is a 400 the form already handles —
// while the consequence of being too strict is a user who cannot sign up at all.
// The address gets confirmed by the verification email regardless.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function isValidProfile(draft: ProfileDraft): boolean {
  const firstName = draft.firstName.trim()
  const lastName = draft.lastName.trim()
  const email = draft.email.trim()

  if (firstName.length < 1 || firstName.length > NAME_MAX_LENGTH) return false
  if (lastName.length < 1 || lastName.length > NAME_MAX_LENGTH) return false
  return EMAIL_PATTERN.test(email)
}

// What actually goes on the wire. Trimming here rather than at the call site
// means the value the user is judged on and the value that is stored are the
// same string.
export function toProfilePayload(draft: ProfileDraft): ProfileDraft {
  return {
    firstName: draft.firstName.trim(),
    lastName: draft.lastName.trim(),
    email: draft.email.trim(),
  }
}
