import * as Sentry from '@sentry/react-native'
import { Stack, useRouter } from 'expo-router'
import * as SplashScreen from 'expo-splash-screen'
import { useEffect, useState } from 'react'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { LanguageProvider } from '@/components/LanguageProvider'
import { setSignedOutHandler } from '@/lib/api'
import { secureTokenStore } from '@/lib/auth/secureTokenStore'
import { colors } from '@/lib/theme'

Sentry.init({
  dsn: process.env.EXPO_PUBLIC_SENTRY_DSN,
  sendDefaultPii: false,
  replaysSessionSampleRate: 0.1,
  replaysOnErrorSampleRate: 1,
  integrations: [
    Sentry.mobileReplayIntegration({
      maskAllText: true,
      maskAllImages: true,
    }),
  ],
})

// Held up until the language preference is read AND the stored session has been
// checked, so a returning user never sees the sign-in screen flash past on the
// way to their own. Failures are swallowed: a splash screen that will not hide
// is a bricked app, and neither of these is worth that.
SplashScreen.preventAutoHideAsync().catch(() => {})

export default Sentry.wrap(function RootLayout() {
  return (
    <SafeAreaProvider>
      {/* LanguageProvider renders nothing until the stored language resolves,
          which is why the splash above has to be held rather than left to
          auto-hide. */}
      <LanguageProvider>
        <Shell />
      </LanguageProvider>
    </SafeAreaProvider>
  )
})

function Shell() {
  const router = useRouter()
  const [booted, setBooted] = useState(false)

  // The api client cannot import the router without a cycle through this file,
  // so the sign-out destination is registered here instead. This fires when a
  // refresh token is rejected outright — the session is gone and no screen
  // inside (app) is reachable any more.
  useEffect(() => {
    setSignedOutHandler(() => {
      router.replace('/(auth)')
    })
    return () => setSignedOutHandler(null)
  }, [router])

  // Cold-launch decision. `/` is the sign-in screen, so a user with a stored
  // session is redirected to /continue, which re-derives their destination from
  // the server rather than trusting anything cached on the device.
  useEffect(() => {
    let cancelled = false
    secureTokenStore
      .read()
      .then((tokens) => {
        if (!cancelled && tokens) router.replace('/continue')
      })
      .catch(() => {
        // An unreadable keychain means no usable session — the sign-in screen
        // is already the right place, so there is nothing to do here.
      })
      .finally(() => {
        if (!cancelled) setBooted(true)
      })
    return () => {
      cancelled = true
    }
  }, [router])

  useEffect(() => {
    if (booted) SplashScreen.hideAsync().catch(() => {})
  }, [booted])

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        // Shared palette, not a literal — this is also what puts
        // @puente/shared/theme into Metro's graph, so a resolution regression
        // fails the bundle rather than waiting for the first screen.
        contentStyle: { backgroundColor: colors.body },
      }}
    >
      <Stack.Screen name="(auth)" />
      <Stack.Screen name="(app)" />
      <Stack.Screen name="continue" />
    </Stack>
  )
}
