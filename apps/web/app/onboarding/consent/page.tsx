import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { apiFetch, getSessionToken, refreshRedirectPath } from '@/lib/session'
import OnboardingShell from '@/components/onboarding/OnboardingShell'
import ConsentForm from '@/components/onboarding/ConsentForm'

export const metadata: Metadata = {
  title: 'Review and Agree | Puente Financial',
  description: 'Review and accept the agreements needed to use Puente.',
  robots: { index: false },
}

// K1: the consent leg of onboarding — sits between the profile form and
// whatever the /continue router picks next. Server-side guards mirror the
// router's so a deep link can't skip a step or re-consent needlessly.
export default async function ConsentPage() {
  const token = await getSessionToken()
  if (!token) redirect(refreshRedirectPath('/onboarding/consent'))

  const res = await apiFetch('/v1/users/me', token)
  if (res.status === 404) redirect('/onboarding/profile')
  if (!res.ok) redirect('/signup')

  const { firstName, lastName, email, consentsCurrent } = (await res.json()) as {
    firstName: string | null
    lastName: string | null
    email: string | null
    consentsCurrent: boolean
  }

  if (!firstName || !lastName || !email) redirect('/onboarding/profile')
  // Already consented to everything current — nothing to show here.
  // /continue only sends users here when consents are NOT current, so this
  // cannot loop.
  if (consentsCurrent) redirect('/continue')

  return (
    <OnboardingShell>
      <ConsentForm />
    </OnboardingShell>
  )
}
