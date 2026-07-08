import type { Metadata } from 'next'
import OnboardingShell from '@/components/onboarding/OnboardingShell'
import OtpForm from '@/components/onboarding/OtpForm'

export const metadata: Metadata = {
  title: 'Verify Your Phone — Puente Financial',
  description: 'Enter the verification code we sent to your phone.',
  robots: { index: false },
}

export default function VerifyPage() {
  return (
    <OnboardingShell>
      <OtpForm />
    </OnboardingShell>
  )
}
