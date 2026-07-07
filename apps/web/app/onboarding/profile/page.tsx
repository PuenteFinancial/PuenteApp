import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getSessionToken } from '@/lib/session'
import OnboardingShell from '@/components/onboarding/OnboardingShell'
import ProfileForm from '@/components/onboarding/ProfileForm'

export const metadata: Metadata = {
  title: 'Your Profile — Puente Financial',
  description: 'Tell us about you to finish creating your Puente account.',
  robots: { index: false },
}

export default async function ProfilePage() {
  const token = await getSessionToken()
  if (!token) redirect('/signup')

  return (
    <OnboardingShell>
      <ProfileForm />
    </OnboardingShell>
  )
}
