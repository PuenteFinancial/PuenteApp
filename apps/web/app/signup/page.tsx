import type { Metadata } from 'next'
import OnboardingShell from '@/components/onboarding/OnboardingShell'
import PhoneForm from '@/components/onboarding/PhoneForm'

export const metadata: Metadata = {
  title: 'Sign Up — Puente Financial',
  description: 'Create your Puente account. Send money home and build your U.S. credit history.',
  robots: { index: false },
}

export default function SignupPage() {
  return (
    <OnboardingShell>
      <PhoneForm />
    </OnboardingShell>
  )
}
