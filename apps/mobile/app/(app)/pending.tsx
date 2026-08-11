import { useLanguage } from '@/components/LanguageProvider'
import { Body, Card, Heading, Screen } from '@/components/ui'

// Stub. The poller that web has (components/onboarding/PendingPoller.tsx) is a
// later slice — until it exists this screen does NOT update on its own, which
// is why `autoNote` is deliberately left off. Promising an automatic refresh
// the app cannot yet perform is worse than saying nothing.
export default function Pending() {
  const { t } = useLanguage()
  const s = t.onboarding.pending

  return (
    <Screen>
      <Card>
        <Heading>{s.title}</Heading>
        <Body>{s.body}</Body>
      </Card>
    </Screen>
  )
}
