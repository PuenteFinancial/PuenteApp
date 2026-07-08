import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getSessionToken } from '@/lib/session'
import OnboardingShell from '@/components/onboarding/OnboardingShell'
import KycStart from '@/components/onboarding/KycStart'

export const metadata: Metadata = {
  title: 'Verify Your Identity — Puente Financial',
  description: 'Verify your identity to start sending money with Puente.',
  robots: { index: false },
}

export default async function KycPage() {
  const token = await getSessionToken()
  if (!token) redirect('/signup')

  return (
    <OnboardingShell>
      <KycStart />
    </OnboardingShell>
  )
}
