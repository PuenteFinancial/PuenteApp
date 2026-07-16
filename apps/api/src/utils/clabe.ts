// CLABE — the 18-digit standardized Mexican bank account number. The last
// digit is a check digit over the first 17: weights cycle 3,7,1 and each
// product is reduced mod 10 BEFORE summing (a plain weighted sum computes the
// wrong digit for some inputs). Algorithm verified against Bridge's own
// validation in sandbox (2026-07-15).

const WEIGHTS = [3, 7, 1]

export function isValidClabe(value: string): boolean {
  if (!/^[0-9]{18}$/.test(value)) return false
  let sum = 0
  for (let i = 0; i < 17; i++) {
    sum += (Number(value[i]) * WEIGHTS[i % 3]) % 10
  }
  const checkDigit = (10 - (sum % 10)) % 10
  return checkDigit === Number(value[17])
}
