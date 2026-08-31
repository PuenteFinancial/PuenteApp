import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { apiFetch, getSessionToken, refreshRedirectPath } from '@/lib/session'
import { isKycAtFirstSendEnabled, isSendMoneyEnabled } from '@/lib/flags'
import StatusCard from '@/components/onboarding/StatusCard'

export const metadata: Metadata = {
  title: 'Dashboard | Puente Financial',
  description: 'Your Puente account.',
  robots: { index: false },
}

export default async function DashboardPage() {
  const token = await getSessionToken()
  if (!token) redirect(refreshRedirectPath('/dashboard'))

  const res = await apiFetch('/v1/users/me', token)
  if (!res.ok) redirect('/signup')

  const { id: userId, kycStatus, consentsCurrent, profileComplete } = (await res.json()) as {
    id: string
    kycStatus: string
    consentsCurrent: boolean
    profileComplete: boolean
  }

  // Deep-link hardening (K2): a typed /dashboard URL must not skip the
  // profile/consent gates the router enforces. /continue re-routes correctly
  // for both flag states, so this cannot loop.
  if (!profileComplete || !consentsCurrent) redirect('/continue')

  const [kycAtFirstSend, sendEnabled] = await Promise.all([
    isKycAtFirstSendEnabled(userId),
    isSendMoneyEnabled(userId),
  ])

  // Old flow only: with KYC at first send (K2 flag), onboarding KYC status no
  // longer gates the dashboard — verification happens inside the send flow
  // (K5). Without this, flag-on users would strand at the pending poller
  // waiting for a KYC that never starts.
  if (!kycAtFirstSend) {
    if (kycStatus === 'rejected') redirect('/onboarding/rejected')
    if (kycStatus !== 'approved') redirect('/onboarding/pending')
  }

  return (
      <StatusCard variant="dashboard" sendEnabled={sendEnabled} kycAtFirstSend={kycAtFirstSend} />
  )
}
