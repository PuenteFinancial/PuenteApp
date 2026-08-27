import { redirect } from 'next/navigation'
import { apiFetch, getSessionToken, refreshRedirectPath } from '@/lib/session'
import { isKycAtFirstSendEnabled } from '@/lib/flags'

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

  const { id, kycStatus, consentsCurrent, profileComplete } = (await res.json()) as {
    id: string
    kycStatus: string
    consentsCurrent: boolean
    profileComplete: boolean
  }

  // Profile gate (K2 widened it to include the address): pre-K2 users with no
  // stored address land back on the profile form once.
  if (!profileComplete) redirect('/onboarding/profile')

  // K1 consent gate: every required consent at its CURRENT version, before
  // anything else. Also catches existing users after a document version bump
  // (K7 swaps in counsel-reviewed docs by bumping versions) — they re-consent
  // on their next visit.
  if (!consentsCurrent) redirect('/onboarding/consent')

  // K2: with KYC moved to first send there is no onboarding KYC branch —
  // profile + consents done means the dashboard. kyc_status still exists (the
  // Persona fallback and old-flow users) but no longer routes onboarding.
  if (await isKycAtFirstSendEnabled(id)) redirect('/dashboard')

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
