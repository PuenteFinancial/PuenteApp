import { useRouter } from 'expo-router'
import { useCallback, useEffect, useState } from 'react'
import { useLanguage } from '@/components/LanguageProvider'
import { Button, Card, ErrorText, Loading, Screen } from '@/components/ui'
import { api } from '@/lib/api'
import { routeAfterSignIn } from '@/lib/auth/routeAfterSignIn'
import type { MeResponse } from '@/lib/auth/types'

/**
 * Mobile's counterpart to apps/web/app/continue/page.tsx — the one place that
 * decides where a signed-in user belongs. Every entry point converges here: a
 * cold launch with a stored session, and (from PR-D2) OTP verification.
 *
 * The decision table itself lives in lib/auth/routeAfterSignIn.ts as a pure
 * function so it can be unit-tested without a navigator. This screen is only
 * the plumbing: fetch, hand the response over, navigate.
 */
export default function ContinueScreen() {
  const router = useRouter()
  const { t } = useLanguage()
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false

    void (async () => {
      try {
        const res = await api.fetch('/v1/users/me')
        // A body that will not parse is not a usable answer; routeAfterSignIn
        // treats `null` on a 2xx as a contract violation and sends the user
        // back to auth rather than into a half-rendered app.
        const body = res.ok ? ((await res.json().catch(() => null)) as MeResponse | null) : null
        if (cancelled) return
        router.replace(routeAfterSignIn({ status: res.status, body }))
      } catch {
        // fetch() only throws on transport failure. That is the phone's
        // network, not an answer about the session — so offer a retry instead
        // of routing anywhere. Bouncing to sign-in here would make a dead cell
        // cost the user another SMS round trip, and the stored session is
        // still perfectly good.
        if (!cancelled) setFailed(true)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [router, attempt])

  const retry = useCallback(() => {
    setFailed(false)
    setAttempt((n) => n + 1)
  }, [])

  if (failed) {
    return (
      <Screen>
        <Card>
          <ErrorText>{t.mobile.connection.error}</ErrorText>
          <Button label={t.mobile.connection.retry} onPress={retry} />
        </Card>
      </Screen>
    )
  }

  return <Loading />
}
