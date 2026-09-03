import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { apiFetch, getSessionToken, refreshRedirectPath, requestOrigin } from '@/lib/session'
import {
  KYC_LOCALE_COOKIE,
  KYC_NEXT_COOKIE,
  validKycLocale,
  validKycNext,
} from '@/lib/kycReturn'

// Bridge redirects here after the user accepts its Terms of Service. No UI.
//
// Two callers share this URL:
//   • K6 send flow (kyc_next cookie set by the pay step): record the
//     acceptance via POST /v1/users/me/bridge-tos and go back to the transfer
//     page, where the machine reboots and continues past its ToS gate. The
//     redirect happens whether or not the write succeeded — server truth
//     decides, and a failed write simply shows the ToS card again.
//   • Flag-OFF onboarding (no cookie): the legacy exchange of the signed
//     agreement for a hosted KYC link, byte-for-byte as before K6.
//
// This is a server component and calls the API directly: no web proxy exists
// for bridge-tos on purpose (one fewer surface adjacent to the KYC relay).
export default async function TosReturnPage({
  searchParams,
}: {
  searchParams: Promise<{ signed_agreement_id?: string }>
}) {
  const { signed_agreement_id: signedAgreementId } = await searchParams

  // The Bridge ToS flow can outlive the ~1 h session — carry the signed
  // agreement through the refresh so the user doesn't have to restart KYC.
  const token = await getSessionToken()
  if (!token) {
    const self = signedAgreementId
      ? `/onboarding/kyc/tos-return?signed_agreement_id=${encodeURIComponent(signedAgreementId)}`
      : '/onboarding/kyc/tos-return'
    redirect(refreshRedirectPath(self))
  }

  if (!signedAgreementId) redirect('/onboarding/kyc?error=1')

  const cookieStore = await cookies()
  const next = validKycNext(cookieStore.get(KYC_NEXT_COOKIE)?.value)

  if (next) {
    // The API only sees this server's address — forward the real client's IP
    // and UA (consents-proxy pattern) so the evidence records the browser
    // that actually assented. Header, never a URL param.
    const headerList = await headers()
    const clientIp =
      headerList.get('x-forwarded-for')?.split(',')[0]?.trim() ||
      headerList.get('x-real-ip') ||
      null
    const userAgent = headerList.get('user-agent')

    const res = await apiFetch('/v1/users/me/bridge-tos', token, {
      method: 'POST',
      body: JSON.stringify({
        signed_agreement_id: signedAgreementId,
        locale: validKycLocale(cookieStore.get(KYC_LOCALE_COOKIE)?.value),
      }),
      headers: {
        ...(clientIp ? { 'x-client-ip': clientIp } : {}),
        ...(userAgent ? { 'user-agent': userAgent } : {}),
      },
    })
    if (!res.ok) {
      // Status only — the body may echo the agreement id.
      console.error('Bridge ToS record failed with status', res.status)
    }
    redirect(next)
  }

  const origin = await requestOrigin()
  const res = await apiFetch('/v1/users/me/kyc-link', token, {
    method: 'POST',
    body: JSON.stringify({
      signed_agreement_id: signedAgreementId,
      ...(origin ? { origin } : {}),
    }),
  })

  if (!res.ok) {
    console.error('KYC link request failed with status', res.status)
    redirect('/onboarding/kyc?error=1')
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
    redirect('/onboarding/kyc?error=1')
  }
  if (protocol !== 'https:' || (!ALLOWED_HOSTS.includes(host) && !host.endsWith('.bridge.xyz'))) {
    // host only — never log the full URL (contains the inquiry/reference ids)
    console.error(`KYC link returned an unexpected redirect host: ${host}`)
    redirect('/onboarding/kyc?error=1')
  }

  redirect(url)
}
