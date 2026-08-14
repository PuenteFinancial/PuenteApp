import { useRouter } from 'expo-router'
import { useEffect, useRef } from 'react'
import { AppState } from 'react-native'
import { useLanguage } from '@/components/LanguageProvider'
import { Body, Caption, Card, Heading, Screen } from '@/components/ui'
import { api } from '@/lib/api'
import { routeAfterSignIn } from '@/lib/auth/routeAfterSignIn'
import type { MeResponse } from '@/lib/auth/types'
import { hasLeftPending } from '@/lib/kyc'

// Mobile's counterpart to apps/web/components/onboarding/PendingPoller.tsx.
//
// The app has no Supabase client, no realtime and no subscription, so it only
// learns kyc_status by asking — and without this it only asks on cold launch
// and when the KYC browser closes. Neither happens while the user sits here, so
// a user who finished Persona waited on a screen that never changed until they
// killed the app.
const POLL_INTERVAL_MS = 30_000

/**
 * The holding screen between finishing KYC and Bridge's webhook deciding it.
 *
 * The routing is not re-derived here — hasLeftPending decides *whether* the
 * wait is over and routeAfterSignIn decides *where* the user goes, which is the
 * same decision table every other entry point uses.
 */
export default function Pending() {
  const { t } = useLanguage()
  const s = t.onboarding.pending
  const router = useRouter()
  const inFlight = useRef(false)

  useEffect(() => {
    let cancelled = false
    let interval: ReturnType<typeof setInterval> | null = null

    const check = async () => {
      if (inFlight.current) return
      inFlight.current = true
      try {
        const res = await api.fetch('/v1/users/me')
        // Only a good answer moves anyone. Handing a failed response to
        // routeAfterSignIn would sign the user out on a transient 500 — it maps
        // every non-2xx to /(auth) — so anything unusable just waits for the
        // next tick. Same reason web returns early on !res.ok.
        if (cancelled || !res.ok) return
        const body = (await res.json().catch(() => null)) as MeResponse | null
        if (cancelled || !body) return

        if (hasLeftPending(body.kycStatus)) {
          router.replace(routeAfterSignIn({ status: res.status, body }))
        }
      } catch {
        // Transport failure — the phone's network, not an answer. Next tick.
      } finally {
        inFlight.current = false
      }
    }

    // No 401 branch on purpose. api.fetch already refreshes on 401 and, when
    // the refresh token is rejected outright, fires the signed-out handler the
    // root layout registered (app/_layout.tsx). A second sign-out path here
    // would be two places that can end a session, disagreeing.

    const start = () => {
      if (interval) return
      interval = setInterval(() => void check(), POLL_INTERVAL_MS)
    }
    const stop = () => {
      if (!interval) return
      clearInterval(interval)
      interval = null
    }

    // Web's `visibilitychange` maps to AppState here, and it is the common
    // case: the user leaves for the SMS or the Bridge email and comes back.
    // Checking on resume is what makes the return feel instant rather than
    // costing up to a full interval.
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        start()
        void check()
      } else {
        // iOS throttles timers in the background unpredictably. Stopping and
        // restarting is honest about when polling actually happens.
        stop()
      }
    })

    start()
    void check()

    return () => {
      cancelled = true
      stop()
      sub.remove()
    }
  }, [router])

  return (
    <Screen>
      <Card>
        <Heading>{s.title}</Heading>
        <Body>{s.body}</Body>
        {/* True as of the poller above — this string was deliberately left off
            while the screen could not keep the promise it makes. */}
        <Caption>{s.autoNote}</Caption>
      </Card>
    </Screen>
  )
}
