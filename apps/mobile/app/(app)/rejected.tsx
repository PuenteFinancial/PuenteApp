import { useLanguage } from '@/components/LanguageProvider'
import { Body, Card, Heading, Screen } from '@/components/ui'

// Stub. Retry and the support hand-off are a later slice.
//
// This copy is identity-verification wording, NOT an adverse action — nothing
// here may read as a credit or account denial (see the NEEDS LEGAL REVIEW note
// above `onboarding.rejected` in the shared string table). The retry CTA and
// Bridge's `reasonLabel` reason strings arrive with the real screen.
export default function Rejected() {
  const { t } = useLanguage()
  const s = t.onboarding.rejected

  return (
    <Screen>
      <Card>
        <Heading>{s.title}</Heading>
        <Body>{s.body}</Body>
      </Card>
    </Screen>
  )
}
