import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { apiFetch, getSessionToken, refreshRedirectPath } from '@/lib/session'
import { isSendMoneyEnabled } from '@/lib/flags'
import OnboardingShell from '@/components/onboarding/OnboardingShell'
import QuoteScreen, { type SendRecipient } from '@/components/send/QuoteScreen'

export const metadata: Metadata = {
  title: 'Send money — Puente Financial',
  description: 'Send money to your recipients.',
  robots: { index: false },
}

interface ApiRecipient {
  id: string
  firstName: string
  lastName: string
  status: string
}

interface ApiDestination {
  id: string
  method: string
  currency: string
  status: string
  label: string | null
  details: { clabeLast4?: string }
}

export default async function SendPage() {
  const token = await getSessionToken()
  if (!token) redirect(refreshRedirectPath('/dashboard/send'))

  // Re-guard on every load: session, KYC, then the feature flag (mirrors the
  // dashboard/recipients guard; the flag dark-launches the whole flow).
  const meRes = await apiFetch('/v1/users/me', token)
  if (!meRes.ok) redirect('/signup')

  const { id: userId, kycStatus } = (await meRes.json()) as { id: string; kycStatus: string }
  if (kycStatus === 'rejected') redirect('/onboarding/rejected')
  if (kycStatus !== 'approved') redirect('/onboarding/pending')
  if (!(await isSendMoneyEnabled(userId))) redirect('/dashboard')

  const listRes = await apiFetch('/v1/recipients?limit=50', token)
  const { data: recipients } = listRes.ok
    ? ((await listRes.json()) as { data: ApiRecipient[] })
    : { data: [] as ApiRecipient[] }

  // N+1 on purpose: MVP list sizes are tiny and this runs server-side on the
  // internal network (same pattern as the recipients page).
  const withDestinations: SendRecipient[] = await Promise.all(
    recipients.map(async (recipient) => {
      const destRes = await apiFetch(`/v1/recipients/${recipient.id}/destinations`, token)
      const { data: destinations } = destRes.ok
        ? ((await destRes.json()) as { data: ApiDestination[] })
        : { data: [] as ApiDestination[] }
      return { ...recipient, destinations }
    }),
  )

  return (
    <OnboardingShell>
      <QuoteScreen recipients={withDestinations} />
    </OnboardingShell>
  )
}
