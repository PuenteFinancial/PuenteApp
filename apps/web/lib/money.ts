// Strict dollars → minor units, ported from the CLI's parseUsdToMinor
// (apps/api/scripts/record-float-topup.ts): the whole point of the money rules
// is that IEEE-754 FRACTIONS never touch an amount — `Number("4.10") * 100`
// is 409.99999… exactly where a cent matters. Here the decimal never exists:
// the regex splits dollars and cents as digit strings, and the arithmetic is
// integer-only, exact by construction — the 12-digit dollar cap bounds the
// result at 1e14, far inside Number.MAX_SAFE_INTEGER. (The CLI uses BigInt
// for the same guarantee; web's ts target predates BigInt literals.)
// Accepts "100", "100.5", "100.50"; anything else is a null (the UI's invalid
// state), never a guess.
export function parseUsdToMinor(input: string): number | null {
  const match = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(input.trim())
  if (!match) return null
  const dollars = Number(match[1]!)
  const cents = Number((match[2] ?? '').padEnd(2, '0'))
  const minor = dollars * 100 + cents
  if (minor <= 0) return null
  return minor
}
