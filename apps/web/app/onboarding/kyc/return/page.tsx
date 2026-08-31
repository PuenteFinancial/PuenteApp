import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { apiFetch, getSessionToken, refreshRedirectPath } from '@/lib/session'
import { KYC_NEXT_COOKIE, resolveKycReturnPath } from '@/lib/kycReturn'

// Bridge redirects here after the hosted KYC flow. No UI — route the user by
// their current KYC status (the webhook may still be in flight). The K5
// send-flow fallback stashes its way home in the kyc_next cookie (the
// Bridge/Persona redirect chain can't carry a query param — both outbound
// URLs are origin-built); resolveKycReturnPath validates it strictly, so the
// client-writable cookie can never steer anywhere but a transfer page.
export default async function KycReturnPage() {
  const token = await getSessionToken()
  if (!token) redirect(refreshRedirectPath('/onboarding/kyc/return'))

  const res = await apiFetch('/v1/users/me', token)
  if (!res.ok) redirect('/signup')

  const { kycStatus } = (await res.json()) as { kycStatus: string }
  const rawNext = (await cookies()).get(KYC_NEXT_COOKIE)?.value
  redirect(resolveKycReturnPath(rawNext, kycStatus))
}
