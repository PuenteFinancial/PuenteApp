import { useLanguage } from '@/components/LanguageProvider'
import { Body, Caption, Card, Heading, Screen } from '@/components/ui'

// Stub. Starting Bridge KYC (hosted link + return handling) is a later slice;
// this exists so the not_started branch of routeAfterSignIn has somewhere real
// to land.
//
// `dataNotice` is the GLBA data-sharing disclosure and renders here from the
// start rather than arriving with the CTA — it is the copy that has to be in
// front of the user before anything is shared with Bridge.
export default function Kyc() {
  const { t } = useLanguage()
  const s = t.onboarding.kyc

  return (
    <Screen>
      <Card>
        <Heading>{s.title}</Heading>
        <Body>{s.body}</Body>
        <Caption>{s.dataNotice}</Caption>
      </Card>
    </Screen>
  )
}
