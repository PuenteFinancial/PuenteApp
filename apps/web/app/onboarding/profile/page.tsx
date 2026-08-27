import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { apiFetch, getSessionToken, refreshRedirectPath } from '@/lib/session'
import OnboardingShell from '@/components/onboarding/OnboardingShell'
import ProfileForm from '@/components/onboarding/ProfileForm'

export const metadata: Metadata = {
  title: 'Your Profile | Puente Financial',
  description: 'Tell us about you to finish creating your Puente account.',
  robots: { index: false },
}

export default async function ProfilePage() {
  const token = await getSessionToken()
  if (!token) redirect(refreshRedirectPath('/onboarding/profile'))

  // Returning users must see their saved profile, not a blank form that
  // would overwrite it. A missing row (404) legitimately means blank.
  let initial = {}
  const res = await apiFetch('/v1/users/me', token)
  if (res.ok) {
    const user = (await res.json()) as {
      firstName: string | null
      lastName: string | null
      email: string | null
      addressLine1: string | null
      addressLine2: string | null
      addressCity: string | null
      addressState: string | null
      addressPostalCode: string | null
    }
    initial = {
      firstName: user.firstName ?? '',
      lastName: user.lastName ?? '',
      email: user.email ?? '',
      addressLine1: user.addressLine1 ?? '',
      addressLine2: user.addressLine2 ?? '',
      addressCity: user.addressCity ?? '',
      addressState: user.addressState ?? '',
      addressPostalCode: user.addressPostalCode ?? '',
    }
  }

  return (
    <OnboardingShell>
      <ProfileForm initial={initial} />
    </OnboardingShell>
  )
}
