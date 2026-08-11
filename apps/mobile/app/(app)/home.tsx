import { useLanguage } from '@/components/LanguageProvider'
import { Body, Card, Heading, Screen } from '@/components/ui'

// Stub. The dashboard proper (balance, recent transfers, send CTA) is a later
// slice of docs/prds/mobile-mvp.md; this exists so the approved-KYC branch of
// routeAfterSignIn has somewhere real to land.
export default function Home() {
  const { t } = useLanguage()
  const s = t.onboarding.dashboard

  return (
    <Screen>
      <Card>
        <Heading>{s.title}</Heading>
        <Body>{s.body}</Body>
      </Card>
    </Screen>
  )
}
