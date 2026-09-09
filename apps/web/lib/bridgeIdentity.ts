// The identity values Bridge needs, and the pure helpers that shape them.
//
// EXTRACTED FROM cryptoPayStep.ts (C3) because both funding rails now reach
// Bridge with the same two values and neither should own the other's copy.
// The Stripe crypto rail gets here after Stripe has already verified the
// sender; the Checkout rail gets here with Bridge as the sole verifier. What
// they share is exactly this: the shape of the two fields, how they are
// normalized, and what counts as invalid.
//
// It lives in its own file rather than in either machine so that retiring the
// crypto rail (PRD §4 phase 2) deletes a rail, not the identity contract.
//
// PII DISCIPLINE. These values are the most sensitive thing the web app ever
// holds. They exist in component state and in the one relay request, and
// nowhere else — never a URL, never analytics, never localStorage, never a log
// line. `buildRelayBody` is the ONLY builder whose output carries them to our
// API; the PII-guard test in cryptoPayStep.test.ts pins which effects may
// carry them, and the API's schema-pii.test.ts pins that only one route file
// names them.

export type TaxIdType = 'ssn' | 'itin'

/** The raw form fields, as typed. DOB is three inputs on purpose: EN and ES
 *  readers order date parts differently, and one text box invites silently
 *  swapped day/month. */
export interface IdentityFormValues {
  dobMonth: string
  dobDay: string
  dobYear: string
  taxId: string
  taxIdType: TaxIdType
}

/** The normalized values, ready for the wire. */
export interface RelayValues {
  /** YYYY-MM-DD */
  dob: string
  taxIdType: TaxIdType
  /** 9 digits, dashes stripped. */
  taxId: string
}

/** Wire body of POST /api/users/me/bridge-customer (mirrors the API's
 *  relayBodySchema — the only route schema that names these fields). */
export interface RelayBody {
  dob: string
  taxId: { type: TaxIdType; number: string }
}

/** KYC resolves fast, but Bridge's database lookup is the slow leg. */
export const BRIDGE_POLL_MS = 3_000
/** Ticks before the Bridge poll gives up on the in-place update and shows the
 *  come-back-later card (~2 min; sandbox approvals land in seconds, live
 *  database lookups in well under this). The draft persists either way. */
export const BRIDGE_POLL_TIMEOUT_TICKS = 40

function digitsOnly(value: string): string {
  return value.replace(/[^0-9]/g, '')
}

/** Normalize the identity fields for the relay: ISO date (zero-padded),
 *  digits-only tax ID. The crypto rail's SDK builder applies the same
 *  normalization, so both providers see identical values. */
export function relayValuesFrom(values: IdentityFormValues): RelayValues {
  const pad = (part: string) => part.trim().padStart(2, '0')
  return {
    dob: `${values.dobYear.trim()}-${pad(values.dobMonth)}-${pad(values.dobDay)}`,
    taxIdType: values.taxIdType,
    taxId: digitsOnly(values.taxId),
  }
}

/** Sanctioned PII carrier (see header). The ONLY builder whose output reaches
 *  our API with identity numbers in it. */
export function buildRelayBody(values: RelayValues): RelayBody {
  return { dob: values.dob, taxId: { type: values.taxIdType, number: values.taxId } }
}

/** DOB + tax ID. An ITIN is nine digits starting with 9 (IRS format); an SSN
 *  is any nine digits — the sandbox's canonical 000000000 must pass. */
export function invalidIdentityFields(values: IdentityFormValues): string[] {
  const bad: string[] = []
  const month = Number(values.dobMonth)
  const day = Number(values.dobDay)
  const year = Number(values.dobYear)
  if (!Number.isInteger(month) || month < 1 || month > 12) bad.push('dobMonth')
  if (!Number.isInteger(day) || day < 1 || day > 31) bad.push('dobDay')
  if (!Number.isInteger(year) || year < 1900 || year > 2100) bad.push('dobYear')
  const digits = values.taxId.replace(/-/g, '')
  const shape = values.taxIdType === 'itin' ? /^9[0-9]{8}$/ : /^[0-9]{9}$/
  if (!shape.test(digits)) bad.push('taxId')
  return bad
}
