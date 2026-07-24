import type { Metadata } from 'next'
import { notFound, redirect } from 'next/navigation'
import { apiFetch, getSessionToken, refreshRedirectPath } from '@/lib/session'
import { isProductionEnv } from '@/lib/flags'
import { isTransferShape } from '@/lib/transferState'
import OnboardingShell from '@/components/onboarding/OnboardingShell'
import TransferTracker from '@/components/send/TransferTracker'
import TransferLoadError from '@/components/send/TransferLoadError'

export const metadata: Metadata = {
  title: 'Your transfer — Puente Financial',
  description: 'Track your transfer.',
  robots: { index: false },
}

// The stable home of a transfer once it exists. Confirm hands off here rather
// than rendering the tracker inside the client-side step machine, so a reload
// (or a link from history in PR4) never strands a sender with money in flight
// and no way to see it.
//
// NOTE the guard ladder is deliberately SHORTER than the one on /dashboard/send
// (session → KYC → flag). This page is where a sender exercises their Reg E
// cancellation right, and the API refuses to gate that on anything but
// ownership — routes/v1/transfers.ts: "canceling is a legal right that must not
// be blocked by KYC status ... owner-scoping is the authorization." Re-adding
// KYC or feature-flag gates here would reintroduce exactly that block on the
// only surface that renders the cancel button: a KYC status flipping to
// manual_review mid-window (Bridge writes it on every customer.updated), a
// PostHog outage resolving the flag to its production-safe false, or an
// operator flipping the kill switch during an incident would each strand a
// sender inside their 30-minute window. Creation stays gated; cancellation
// doesn't. Owner-scoping on GET /v1/transfers/:id is the authorization.
export default async function TransferPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  const token = await getSessionToken()
  if (!token) redirect(refreshRedirectPath(`/dashboard/send/${id}`))

  const res = await apiFetch(`/v1/transfers/${encodeURIComponent(id)}`, token)

  // A lapsed session is recoverable — bounce through the refresh hop rather
  // than showing a dead end.
  if (res.status === 401) redirect(refreshRedirectPath(`/dashboard/send/${id}`))

  // Only a real 404 (owner-scoped: another user's transfer is simply not found)
  // is "no such transfer". A 500/503 is transient and must not be reported as
  // nonexistent to someone whose money is in flight.
  if (res.status === 404) notFound()
  if (!res.ok) {
    return (
      <OnboardingShell>
        <TransferLoadError />
      </OnboardingShell>
    )
  }

  const transfer = await res.json()
  // An unrecognized shape is a contract fault, not a missing transfer.
  if (!isTransferShape(transfer)) {
    return (
      <OnboardingShell>
        <TransferLoadError />
      </OnboardingShell>
    )
  }

  return (
    <OnboardingShell>
      <TransferTracker initialTransfer={transfer} canSimulate={!isProductionEnv()} />
    </OnboardingShell>
  )
}
