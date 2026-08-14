import type { PayoutDestination } from '@puente/shared'
import { useQueries, useQuery } from '@tanstack/react-query'
import { useRouter } from 'expo-router'
import { useCallback, useEffect } from 'react'
import { View } from 'react-native'
import { useLanguage } from '@/components/LanguageProvider'
import { Body, Button, Caption, Card, ErrorText, Heading, Loading, Screen } from '@/components/ui'
import {
  fetchDestinations,
  fetchRecipients,
  isKycGateError,
  recipientKeys,
} from '@/lib/queries/recipients'

/**
 * The people you send money to, and where the money arrives.
 *
 * Read-only in this slice — add/archive land next. Web's counterpart
 * (apps/web/components/recipients/RecipientsManager.tsx) is a server component
 * fed by a page that fetches everything before rendering, so it has no loading,
 * error or empty-with-a-spinner states to port. Those are written here for the
 * first time.
 */
export default function Recipients() {
  const { t } = useLanguage()
  const s = t.recipients
  const router = useRouter()

  const list = useQuery({
    queryKey: recipientKeys.list(),
    queryFn: fetchRecipients,
  })

  // The N+1, run in parallel. Web does the same 1 + N (its page.tsx says so
  // outright) but server-side on the internal network; here it costs two round
  // trips of latency rather than N sequential ones, because every destinations
  // request starts the moment the list resolves. Revisit with a joined endpoint
  // only if this measurably drags on a real device.
  const destinationQueries = useQueries({
    queries: (list.data ?? []).map((recipient) => ({
      queryKey: recipientKeys.destinations(recipient.id),
      queryFn: () => fetchDestinations(recipient.id),
    })),
  })

  // A 403 is the API saying this user is not KYC-approved, which is a routing
  // problem and not something to render. Web redirects in the server component;
  // the equivalent here is to send them back through the single routing brain
  // rather than leave them on an error they cannot act on. Only reachable by
  // deep link or a session that went stale mid-screen — the entry point on home
  // already implies approved.
  const gated = isKycGateError(list.error)
  useEffect(() => {
    if (gated) router.replace('/continue')
  }, [gated, router])

  const refresh = useCallback(() => {
    void list.refetch()
    // The destination queries key off the list, so refetching them individually
    // would race the list that decides which of them should exist at all.
    for (const query of destinationQueries) void query.refetch()
  }, [list, destinationQueries])

  if (list.isPending || gated) return <Loading />

  if (list.isError) {
    return (
      <Screen>
        <Card>
          <ErrorText>{t.mobile.connection.error}</ErrorText>
          <Button label={t.mobile.connection.retry} onPress={() => void list.refetch()} />
        </Card>
      </Screen>
    )
  }

  const recipients = list.data

  return (
    <Screen scroll onRefresh={refresh} refreshing={list.isFetching}>
      <Card>
        <Heading>{s.title}</Heading>
        <Body>{s.sub}</Body>
        {recipients.length === 0 && <Caption>{s.empty}</Caption>}
      </Card>

      {recipients.map((recipient, index) => (
        <Card key={recipient.id}>
          <Heading>
            {recipient.firstName} {recipient.lastName}
          </Heading>
          <Caption>{recipient.relationship}</Caption>
          {/* Index-matched: useQueries returns results in the order the query
              array was built, which is the order of `recipients`. */}
          <DestinationList destinations={destinationQueries[index]?.data} />
        </Card>
      ))}
    </Screen>
  )
}

function DestinationList({ destinations }: { destinations: PayoutDestination[] | undefined }) {
  const { t } = useLanguage()
  const s = t.recipients

  // Undefined means that recipient's destinations are still in flight. Nothing
  // is rendered rather than a per-card spinner: the cards arrive together and a
  // row of spinners inside them reads as breakage, not progress.
  if (!destinations || destinations.length === 0) return null

  return (
    <View style={{ gap: 4 }}>
      {destinations.map((destination) => (
        <Caption key={destination.id}>
          {destination.label || s.bankAccount}{' '}
          {s.accountEnding.replace('{last4}', destination.details.clabeLast4 ?? '')}
        </Caption>
      ))}
    </View>
  )
}
