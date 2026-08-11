import { useLanguage } from '@/components/LanguageProvider'
import { Body, Card, Heading, Screen } from '@/components/ui'

// The app's front door and the cold-launch destination for anyone without a
// stored session.
//
// PR-D1 (this slice) renders the heading only. The phone field, the TCPA
// consent checkbox and the legal links are PR-D2 — that surface is
// compliance-reviewed as a unit, and half of it landing early is how a consent
// screen ships without its consent.
export default function Welcome() {
  const { t } = useLanguage()
  const s = t.onboarding.signup

  return (
    <Screen>
      <Card>
        <Heading>{s.title}</Heading>
        <Body>{s.sub}</Body>
      </Card>
    </Screen>
  )
}
