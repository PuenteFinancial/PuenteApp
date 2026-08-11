import { Stack } from 'expo-router'
import { SignupPhoneProvider } from '@/components/SignupPhoneContext'

// The unauthenticated group. The phone number lives in React state scoped to
// this layout, so it exists for exactly as long as the two-screen sign-in flow
// and is gone the moment the user leaves it — see SignupPhoneContext for why
// it is not persisted anywhere.
export default function AuthLayout() {
  return (
    <SignupPhoneProvider>
      <Stack screenOptions={{ headerShown: false }} />
    </SignupPhoneProvider>
  )
}
