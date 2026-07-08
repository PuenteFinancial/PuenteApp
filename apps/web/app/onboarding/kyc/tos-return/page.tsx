import { redirect } from 'next/navigation'
import { apiFetch, getSessionToken } from '@/lib/session'

// Bridge redirects here after the user accepts its Terms of Service.
// No UI — exchange the signed agreement for a hosted KYC link and go there.
export default async function TosReturnPage({
  searchParams,
}: {
  searchParams: Promise<{ signed_agreement_id?: string }>
}) {
  const token = await getSessionToken()
  if (!token) redirect('/signup')

  const { signed_agreement_id: signedAgreementId } = await searchParams
  if (!signedAgreementId) redirect('/onboarding/kyc')

  const res = await apiFetch('/v1/users/me/kyc-link', token, {
    method: 'POST',
    body: JSON.stringify({ signed_agreement_id: signedAgreementId }),
  })

  if (!res.ok) {
    console.error('KYC link request failed with status', res.status)
    redirect('/onboarding/kyc')
  }

  const { url } = (await res.json()) as { url: string }

  // Only follow redirects to Bridge or its KYC vendor Persona — a compromised
  // or misbehaving upstream must not be able to send users to an arbitrary
  // site. Bridge's hosted KYC URLs live on bridge.withpersona.com.
  const ALLOWED_HOSTS = ['bridge.xyz', 'bridge.withpersona.com']
  let host = ''
  let protocol = ''
  try {
    const parsed = new URL(url)
    host = parsed.hostname
    protocol = parsed.protocol
  } catch {
    redirect('/onboarding/kyc')
  }
  if (protocol !== 'https:' || (!ALLOWED_HOSTS.includes(host) && !host.endsWith('.bridge.xyz'))) {
    // host only — never log the full URL (contains the inquiry/reference ids)
    console.error(`KYC link returned an unexpected redirect host: ${host}`)
    redirect('/onboarding/kyc')
  }

  redirect(url)
}
