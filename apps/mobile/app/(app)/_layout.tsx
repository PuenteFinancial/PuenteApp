import { Stack, useRouter } from 'expo-router'
import { useEffect, useState } from 'react'
import { Loading } from '@/components/ui'
import { secureTokenStore } from '@/lib/auth/secureTokenStore'

/**
 * The authenticated half of the app. Nothing under (app) renders until a stored
 * session is confirmed to exist.
 *
 * This checks only for the *presence* of tokens, not their validity — deciding
 * whether a session is still good is the api client's job (it refreshes, and
 * calls back into the root layout's sign-out handler when the refresh token is
 * rejected). Duplicating that judgement here would mean two places that can
 * sign a user out, disagreeing.
 */
export default function AppLayout() {
  const router = useRouter()
  const [checked, setChecked] = useState(false)

  useEffect(() => {
    let cancelled = false
    secureTokenStore
      .read()
      .then((tokens) => {
        if (cancelled) return
        if (!tokens) {
          router.replace('/(auth)')
          return
        }
        setChecked(true)
      })
      .catch(() => {
        // An unreadable keychain is indistinguishable from no session here, and
        // the safe reading of "I cannot tell" on the authenticated side of the
        // app is "not signed in".
        if (!cancelled) router.replace('/(auth)')
      })
    return () => {
      cancelled = true
    }
  }, [router])

  if (!checked) return <Loading />

  return <Stack screenOptions={{ headerShown: false }} />
}
