import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { apiFetch, getSessionToken } from '@/lib/session'
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

  // "Verifying your identity" is a lie for rejected/approved users — route
  // them to their real state. A failed fetch keeps rendering pending rather
  // than dead-ending the user.
  const res = await apiFetch('/v1/users/me', token)
  if (res.ok) {
    const { kycStatus } = (await res.json()) as { kycStatus: string }
    if (kycStatus === 'rejected') redirect('/onboarding/rejected')
    if (kycStatus === 'approved') redirect('/dashboard')
  }

  return (
    <OnboardingShell>
      <StatusCard variant="pending" />
    </OnboardingShell>
  )
}
