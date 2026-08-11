import { useLanguage } from '@/components/LanguageProvider'
import { Body, Button, Card, Heading, Screen } from '@/components/ui'
import { api } from '@/lib/api'

// Stub. The dashboard proper (balance, recent transfers, send CTA) is a later
// slice of docs/prds/mobile-mvp.md; this exists so the approved-KYC branch of
// routeAfterSignIn has somewhere real to land.
//
// Sign-out is here rather than waiting for the real dashboard because without
// it there is no way off a signed-in device short of deleting the app — which
// also makes the auth flow impossible to exercise more than once.
export default function Home() {
  const { t } = useLanguage()
  const s = t.onboarding.dashboard

  return (
    <Screen>
      <Card>
        <Heading>{s.title}</Heading>
        <Body>{s.body}</Body>
      </Card>
      {/* api.signOut clears the token store and fires the root layout's
          signed-out handler, which routes back to (auth). Local-only: there is
          no server-side revocation endpoint, same posture as web. */}
      <Button label={t.mobile.signOut} onPress={() => void api.signOut()} variant="ghost" />
    </Screen>
  )
}
