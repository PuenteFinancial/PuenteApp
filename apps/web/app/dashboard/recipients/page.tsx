import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { apiFetch, getSessionToken, refreshRedirectPath } from '@/lib/session'
import { isKycAtFirstSendEnabled } from '@/lib/flags'
import RecipientsManager, {
  type RecipientWithDestinations,
} from '@/components/recipients/RecipientsManager'

export const metadata: Metadata = {
  title: 'Recipients | Puente Financial',
  description: 'Manage the people you send money to.',
  robots: { index: false },
}

interface ApiRecipient {
  id: string
  firstName: string
  lastName: string
  relationship: string
  country: string
  status: string
}

interface ApiDestination {
  id: string
  method: string
  currency: string
  details: { clabeLast4?: string }
  label: string | null
  status: string
}

export default async function RecipientsPage() {
  const token = await getSessionToken()
  if (!token) redirect(refreshRedirectPath('/dashboard/recipients'))

  const meRes = await apiFetch('/v1/users/me', token)
  if (!meRes.ok) redirect('/signup')

  const { id: userId, kycStatus } = (await meRes.json()) as { id: string; kycStatus: string }
  // K5: under KYC-at-first-send, recipients are manageable BEFORE any
  // verification (the server gate agrees — requireOnboardedUser checks
  // profile+consents, not kyc_status, on the deferred rail). Only the
  // rejection ladder survives the flag; without this skip the dashboard's
  // "Manage recipients" CTA bounced flag-ON users to the pending poller.
  if (kycStatus === 'rejected') redirect('/onboarding/rejected')
  if (!(await isKycAtFirstSendEnabled(userId)) && kycStatus !== 'approved') {
    redirect('/onboarding/pending')
  }

  const listRes = await apiFetch('/v1/recipients?limit=50', token)
  const { data: recipients } = listRes.ok
    ? ((await listRes.json()) as { data: ApiRecipient[] })
    : { data: [] as ApiRecipient[] }

  // N+1 on purpose: MVP list sizes are tiny and this runs server-side on the
  // internal network. Revisit with a joined endpoint if lists grow.
  const withDestinations: RecipientWithDestinations[] = await Promise.all(
    recipients.map(async (recipient) => {
      const destRes = await apiFetch(`/v1/recipients/${recipient.id}/destinations`, token)
      const { data: destinations } = destRes.ok
        ? ((await destRes.json()) as { data: ApiDestination[] })
        : { data: [] as ApiDestination[] }
      return { ...recipient, destinations }
    }),
  )

  return (
      <RecipientsManager initialRecipients={withDestinations} />
  )
}
