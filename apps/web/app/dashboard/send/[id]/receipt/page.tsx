import type { Metadata } from 'next'
import { notFound, redirect } from 'next/navigation'
import { apiFetch, getSessionToken, refreshRedirectPath } from '@/lib/session'
import { isTransferShape } from '@/lib/transferState'
import { isReceiptContent } from '@/lib/disclosure'
import ReceiptView from '@/components/send/ReceiptView'
import TransferLoadError from '@/components/send/TransferLoadError'

export const metadata: Metadata = {
  title: 'Transfer receipt | Puente Financial',
  description: 'Your transfer receipt.',
  robots: { index: false },
}

// The receipt for a COMPLETED transfer. We fetch the transfer FIRST (owner-scoped,
// like the tracker page): a missing / non-owned id 404s, and a transfer that
// hasn't been delivered yet has no receipt — so rather than a broken-looking 404,
// we send the sender to its tracker, where the live status is shown. Only a
// COMPLETED transfer renders the receipt. Owner-scoping is the authorization; the
// guard ladder is deliberately short (session → refresh), matching the tracker
// page — a receipt is a post-creation artifact, not re-gated on KYC/flag.
export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  const token = await getSessionToken()
  if (!token) redirect(refreshRedirectPath(`/dashboard/send/${id}/receipt`))

  const transferRes = await apiFetch(`/v1/transfers/${encodeURIComponent(id)}`, token)
  if (transferRes.status === 401) redirect(refreshRedirectPath(`/dashboard/send/${id}/receipt`))
  if (transferRes.status === 404) notFound()
  if (!transferRes.ok) {
    return (
        <TransferLoadError />
    )
  }

  // .catch(() => null): a 2xx + non-JSON (gateway HTML) makes .json() throw; let
  // the shape guard reject null and route to TransferLoadError, not a raw crash.
  const transfer = await transferRes.json().catch(() => null)
  if (!isTransferShape(transfer)) {
    return (
        <TransferLoadError />
    )
  }

  // No receipt exists until the transfer is delivered — send them to the live
  // tracker instead of a 404 for a real, in-flight (or canceled) transfer.
  if (transfer.state !== 'COMPLETED') redirect(`/dashboard/send/${id}`)

  const receiptRes = await apiFetch(`/v1/transfers/${encodeURIComponent(id)}/receipt`, token)
  if (!receiptRes.ok) {
    // COMPLETED but the receipt row isn't readable yet (a brief write race) or a
    // transient fault — a retryable load error, not a dead end.
    return (
        <TransferLoadError />
    )
  }

  const body = await receiptRes.json().catch(() => null)
  if (!isReceiptContent(body)) {
    return (
        <TransferLoadError />
    )
  }

  return (
      <ReceiptView content={body.content} transferId={id} />
  )
}
