import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getSessionToken } from '@/lib/session'
import OnboardingShell from '@/components/onboarding/OnboardingShell'
import StatusCard from '@/components/onboarding/StatusCard'

export const metadata: Metadata = {
  title: 'Verification In Progress — Puente Financial',
  description: 'Your identity verification is under review.',
  robots: { index: false },
}

export default async function PendingPage() {
  const token = await getSessionToken()
  if (!token) redirect('/signup')

  return (
    <OnboardingShell>
      <StatusCard variant="pending" />
    </OnboardingShell>
  )
}
