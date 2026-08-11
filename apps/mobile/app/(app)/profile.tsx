import { useLanguage } from '@/components/LanguageProvider'
import { Body, Card, Heading, Screen } from '@/components/ui'

// Stub. The profile form (legal name + email, POST /v1/users/me) is a later
// slice; this exists so the incomplete-profile branch of routeAfterSignIn has
// somewhere real to land.
export default function Profile() {
  const { t } = useLanguage()
  const s = t.onboarding.profile

  return (
    <Screen>
      <Card>
        <Heading>{s.title}</Heading>
        <Body>{s.sub}</Body>
      </Card>
    </Screen>
  )
}
