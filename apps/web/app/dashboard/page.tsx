import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { apiFetch, getSessionToken, refreshRedirectPath } from '@/lib/session'
import OnboardingShell from '@/components/onboarding/OnboardingShell'
import StatusCard from '@/components/onboarding/StatusCard'

export const metadata: Metadata = {
  title: 'Dashboard — Puente Financial',
  description: 'Your Puente account.',
  robots: { index: false },
}

export default async function DashboardPage() {
  const token = await getSessionToken()
  if (!token) redirect(refreshRedirectPath('/dashboard'))

  const res = await apiFetch('/v1/users/me', token)
  if (!res.ok) redirect('/signup')

  const { kycStatus } = (await res.json()) as { kycStatus: string }
  if (kycStatus === 'rejected') redirect('/onboarding/rejected')
  if (kycStatus !== 'approved') redirect('/onboarding/pending')

  return (
    <OnboardingShell>
      <StatusCard variant="dashboard" />
    </OnboardingShell>
  )
}
