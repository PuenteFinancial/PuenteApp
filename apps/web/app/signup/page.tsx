import type { Metadata } from 'next'
import OnboardingShell from '@/components/onboarding/OnboardingShell'
import PhoneForm from '@/components/onboarding/PhoneForm'

export const metadata: Metadata = {
  title: 'Sign In or Sign Up — Puente Financial',
  description: 'Sign in to Puente or create your account. Send money home and build your U.S. credit history.',
  robots: { index: false },
}

export default function SignupPage() {
  return (
    <OnboardingShell>
      <PhoneForm />
    </OnboardingShell>
  )
}
