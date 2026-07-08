export const SIGNUP_PHONE_KEY = 'puente_signup_phone'

// Digits only, US country code prepended when a bare 10-digit number is
// entered — matches the format Supabase phone auth is configured with.
export function normalizePhone(input: string): string {
  const digits = input.replace(/\D/g, '')
  return digits.length === 10 ? `1${digits}` : digits
}
