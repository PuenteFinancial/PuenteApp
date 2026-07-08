import { redirect } from 'next/navigation'
import { apiFetch, getSessionToken, refreshRedirectPath } from '@/lib/session'

// The single post-sign-in router. Every entry point converges here — the
// OTP verify form, the landing-page sign-in, and any page that finds a
// valid session in the wrong place. Routing lives server-side so a stale
// client bundle can never run yesterday's rules.
export default async function ContinuePage() {
  // No session cookie usually means it expired (~1 h) — try a silent
  // refresh before giving up; the handler falls through to /signup.
  const token = await getSessionToken()
  if (!token) redirect(refreshRedirectPath('/continue'))

  const res = await apiFetch('/v1/users/me', token)

  // Row missing (deleted out-of-band or predating the auth trigger): the
  // verify handler self-heals it on the next sign-in; meanwhile the profile
  // form is the right destination.
  if (res.status === 404) redirect('/onboarding/profile')
  if (!res.ok) redirect('/signup')

  const { firstName, lastName, email, kycStatus } = (await res.json()) as {
    firstName: string | null
    lastName: string | null
    email: string | null
    kycStatus: string
  }

  if (!firstName || !lastName || !email) redirect('/onboarding/profile')

  switch (kycStatus) {
    case 'not_started':
      redirect('/onboarding/kyc')
    case 'rejected':
      redirect('/onboarding/rejected')
    case 'approved':
      redirect('/dashboard')
    default:
      // pending, manual_review, and anything unrecognized
      redirect('/onboarding/pending')
  }
}
