import * as Sentry from '@sentry/react-native'
import { Stack } from 'expo-router'
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

export default Sentry.wrap(function RootLayout() {
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
    </Stack>
  )
})
