import { redirect } from 'next/navigation'
import { apiFetch, getSessionToken } from '@/lib/session'

// Bridge redirects here after the hosted KYC flow. No UI — route the user
// by their current KYC status (the webhook may still be in flight).
export default async function KycReturnPage() {
  const token = await getSessionToken()
  if (!token) redirect('/signup')

  const res = await apiFetch('/v1/users/me', token)
  if (!res.ok) redirect('/signup')

  const { kycStatus } = (await res.json()) as { kycStatus: string }
  if (kycStatus === 'approved') redirect('/dashboard')
  if (kycStatus === 'rejected') redirect('/onboarding/rejected')
  redirect('/onboarding/pending')
}
