import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { apiFetch, getSessionToken, refreshRedirectPath } from '@/lib/session'
import { isTransferShape } from '@/lib/transferState'
import OnboardingShell from '@/components/onboarding/OnboardingShell'
import TransferHistory from '@/components/send/TransferHistory'

export const metadata: Metadata = {
  title: 'Transfer history — Puente Financial',
  description: 'Your past transfers.',
  robots: { index: false },
}

// The sender's transaction history — money-moved transfers only (scope=history
// hides abandoned, never-funded sends; see docs/decisions.md). Short guard ladder
// (session → refresh), matching the tracker/receipt pages: owner-scoping is the
// authorization, and discoverability is gated by the flag on the dashboard CTA,
// so this read surface isn't re-gated on KYC/flag.
export default async function TransfersPage() {
  const token = await getSessionToken()
  if (!token) redirect(refreshRedirectPath('/dashboard/transfers'))

  const res = await apiFetch('/v1/transfers?scope=history&limit=20', token)
  if (res.status === 401) redirect(refreshRedirectPath('/dashboard/transfers'))

  let data: unknown[] = []
  let nextCursor: string | null = null
  let loadFailed = false
  if (res.ok) {
    const body = (await res.json().catch(() => ({}))) as { data?: unknown; nextCursor?: unknown }
    if (Array.isArray(body.data)) {
      data = body.data
      if (typeof body.nextCursor === 'string') nextCursor = body.nextCursor
    } else {
      // A 2xx whose body isn't a { data: array } violates the list contract
      // (e.g. a gateway 200 + HTML past the proxy) — a fault, not an empty
      // history. Fall into the same retryable-error path as a 5xx.
      loadFailed = true
    }
  } else {
    // A non-401 failure must not render as an empty history — flag it so the
    // client shows a retryable error instead of "you haven't sent anything".
    loadFailed = true
  }

  const initial = data.filter(isTransferShape)

  return (
    <OnboardingShell>
      <TransferHistory initial={initial} initialCursor={nextCursor} loadFailed={loadFailed} />
    </OnboardingShell>
  )
}
