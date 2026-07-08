import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { apiFetch, getSessionToken } from '@/lib/session'
import OnboardingShell from '@/components/onboarding/OnboardingShell'
import RejectedCard from '@/components/onboarding/RejectedCard'

export const metadata: Metadata = {
  title: 'Identity Verification — Puente Financial',
  description: 'Your identity verification needs another attempt.',
  robots: { index: false },
}

export default async function RejectedPage() {
  const token = await getSessionToken()
  if (!token) redirect('/signup')

  const userRes = await apiFetch('/v1/users/me', token)
  if (!userRes.ok) redirect('/signup')

  // This page is only truthful for rejected users — route everyone else
  // to the screen that matches their actual state.
  const { kycStatus } = (await userRes.json()) as { kycStatus: string }
  if (kycStatus === 'approved') redirect('/dashboard')
  if (kycStatus !== 'rejected') redirect('/onboarding/pending')

  // Reasons degrade to generic copy on any failure — the page must render
  // regardless. Reason strings stay out of logs and URLs.
  let reasons: string[] = []
  let retriesRemaining = 0
  const rejectionRes = await apiFetch('/v1/users/me/kyc-rejection', token)
  if (rejectionRes.ok) {
    const info = (await rejectionRes.json()) as { reasons: string[]; retriesRemaining: number }
    reasons = info.reasons
    retriesRemaining = info.retriesRemaining
  }

  return (
    <OnboardingShell>
      <RejectedCard reasons={reasons} retriesRemaining={retriesRemaining} />
    </OnboardingShell>
  )
}
