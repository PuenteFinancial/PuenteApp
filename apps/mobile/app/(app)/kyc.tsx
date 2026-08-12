import * as Crypto from 'expo-crypto'
import { useRouter } from 'expo-router'
import * as SecureStore from 'expo-secure-store'
import * as WebBrowser from 'expo-web-browser'
import { useCallback, useState } from 'react'
import { useLanguage } from '@/components/LanguageProvider'
import { Body, Button, Caption, Card, ErrorText, Heading, Screen } from '@/components/ui'
import { api } from '@/lib/api'
import { routeAfterSignIn } from '@/lib/auth/routeAfterSignIn'
import type { MeResponse } from '@/lib/auth/types'
import {
  KYC_STATE_KEY,
  parseStoredState,
  parseTosReturn,
  routeAfterKycReturn,
  serializeState,
  stateMatches,
} from '@/lib/kyc'

// The scheme half of the redirect the API mints. openAuthSessionAsync closes
// the browser as soon as the page navigates here and hands the full URL back.
const TOS_RETURN_URL = 'puente://kyc/tos-return'

/**
 * Identity verification: Bridge's Terms of Service, then Persona's hosted KYC.
 *
 * Two legs, deliberately handled differently, because only one carries a
 * payload:
 *
 *   1. **ToS** — must return `signed_agreement_id` to the app, so it runs in an
 *      auth session that closes on our own scheme. A nonce proves the return is
 *      one we started (see lib/kyc.ts for why that matters).
 *   2. **Persona** — returns nothing the app needs; `kyc_status` arrives by
 *      webhook. So it opens in an ordinary browser the user closes, and the app
 *      re-reads the server afterwards. No redirect interception, and nothing
 *      that depends on Bridge accepting a custom scheme on that leg.
 */
export default function Kyc() {
  const { t } = useLanguage()
  const s = t.onboarding.kyc
  const router = useRouter()

  const [status, setStatus] = useState<'idle' | 'starting' | 'error'>('idle')

  const start = useCallback(async () => {
    if (status === 'starting') return
    setStatus('starting')

    try {
      // A fresh nonce per attempt: an abandoned run can never validate a later
      // return. randomUUID is 122 bits of entropy and satisfies the API's
      // pattern for `state` as-is.
      const state = Crypto.randomUUID()
      await SecureStore.setItemAsync(KYC_STATE_KEY, serializeState(state, Date.now()))

      const tosRes = await api.fetch('/v1/users/me/tos-link', {
        method: 'POST',
        body: JSON.stringify({ platform: 'mobile', state }),
      })
      if (!tosRes.ok) {
        setStatus('error')
        return
      }
      const { url: tosUrl } = (await tosRes.json()) as { url: string }

      const result = await WebBrowser.openAuthSessionAsync(tosUrl, TOS_RETURN_URL)
      if (result.type !== 'success') {
        // Cancelled or dismissed — not a failure, just a user who backed out.
        // Drop the nonce so it cannot validate anything later.
        await SecureStore.deleteItemAsync(KYC_STATE_KEY)
        setStatus('idle')
        return
      }

      const returned = parseTosReturn(result.url)
      const stored = parseStoredState(await SecureStore.getItemAsync(KYC_STATE_KEY))
      // Single-use: consumed whether or not it matched.
      await SecureStore.deleteItemAsync(KYC_STATE_KEY)

      if (!returned || !stateMatches(returned.state, stored, Date.now())) {
        // Either a malformed return or one this app never initiated. The
        // agreement id is discarded unexchanged — this is the branch the whole
        // nonce exists for.
        setStatus('error')
        return
      }

      const kycRes = await api.fetch('/v1/users/me/kyc-link', {
        method: 'POST',
        body: JSON.stringify({ signed_agreement_id: returned.signedAgreementId }),
      })
      if (!kycRes.ok) {
        setStatus('error')
        return
      }
      const { url: kycUrl } = (await kycRes.json()) as { url: string }

      // Persona needs the camera for document capture, which is unreliable
      // inside an embedded WebView — the system browser is the supported
      // surface for it.
      await WebBrowser.openBrowserAsync(kycUrl)

      // The user is back from Persona. Ask the server rather than assuming —
      // but route on RETURN rules, not sign-in rules.
      //
      // The webhook that flips kyc_status has almost certainly not landed yet:
      // kyc-link only records bridge_customer_id, so the status is still
      // `not_started` at this moment, and routeAfterSignIn maps that to the KYC
      // screen. Using it here would drop the user back onto "verify your
      // identity" seconds after they finished it.
      //
      // A body we cannot read is a different problem — an unusable session, not
      // an undecided KYC — so that falls through to the general router, which
      // sends it back to auth.
      const meRes = await api.fetch('/v1/users/me')
      const body = meRes.ok ? ((await meRes.json().catch(() => null)) as MeResponse | null) : null
      router.replace(
        body ? routeAfterKycReturn(body.kycStatus) : routeAfterSignIn({ status: meRes.status, body: null }),
      )
    } catch {
      // Transport failure at any step. The nonce may be orphaned in the
      // keychain; it is overwritten on the next attempt and useless meanwhile.
      setStatus('error')
    }
  }, [status, router])

  return (
    <Screen scroll>
      <Card>
        <Heading>{s.title}</Heading>
        <Body>{s.body}</Body>
        {/* GLBA: the data hand-off to Bridge is disclosed before the user can
            continue, not after. Do not move this below the button. */}
        <Caption>{s.dataNotice}</Caption>

        <Button
          label={status === 'starting' ? s.starting : s.cta}
          onPress={() => void start()}
          disabled={status === 'starting'}
        />

        {status === 'error' && <ErrorText>{s.error}</ErrorText>}
      </Card>
    </Screen>
  )
}
