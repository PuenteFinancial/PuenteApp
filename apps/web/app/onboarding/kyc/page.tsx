import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { apiFetch, getSessionToken } from '@/lib/session'
import OnboardingShell from '@/components/onboarding/OnboardingShell'
import KycStart from '@/components/onboarding/KycStart'

export const metadata: Metadata = {
  title: 'Verify Your Identity — Puente Financial',
  description: 'Verify your identity to start sending money with Puente.',
  robots: { index: false },
}

export default async function KycPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  const token = await getSessionToken()
  if (!token) redirect('/signup')

  // Already-verified users have nothing to do here (fetch failure → render
  // as before rather than dead-ending)
  const res = await apiFetch('/v1/users/me', token)
  if (res.ok) {
    const { kycStatus } = (await res.json()) as { kycStatus: string }
    if (kycStatus === 'approved') redirect('/dashboard')
  }

  const { error } = await searchParams

  return (
    <OnboardingShell>
      <KycStart initialError={Boolean(error)} />
    </OnboardingShell>
  )
}
