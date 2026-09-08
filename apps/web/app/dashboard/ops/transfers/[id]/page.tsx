import type { Metadata } from 'next'
import { notFound, redirect } from 'next/navigation'
import { apiFetch, getSessionToken, refreshRedirectPath } from '@/lib/session'
import { isOpsTransferDetailShape } from '@/lib/opsTransferDetail'
import { isUuid } from '@/lib/uuid'
import OpsTransferDetailView from '@/components/ops/OpsTransferDetailView'
import OpsLoadFailed from '@/components/ops/OpsLoadFailed'

export const metadata: Metadata = {
  title: 'Transfer | Operations | Puente Financial',
  robots: { index: false },
}

// The per-transfer ops page (ops board slice 1). Same posture as the board
// (ops/page.tsx): no nav entry, reached from a board card or by direct URL,
// and the real gate is the API's OPS_ADMIN_USER_IDS allowlist — a non-admin's
// fetch 404s and this page renders Next's stock not-found. Only the transfer
// id ever appears in the URL (#215), and it is shape-checked BEFORE any fetch
// so a typo never travels upstream and never reads as "load failed".
export default async function OpsTransferPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!isUuid(id)) notFound()

  const path = `/dashboard/ops/transfers/${id}`
  const token = await getSessionToken()
  if (!token) redirect(refreshRedirectPath(path))

  const res = await apiFetch(`/v1/ops/transfers/${encodeURIComponent(id)}`, token)
  if (res.status === 401) redirect(refreshRedirectPath(path))
  if (res.status === 404) notFound()

  if (!res.ok) {
    return <OpsLoadFailed />
  }

  const body = (await res.json().catch(() => null)) as unknown
  if (!isOpsTransferDetailShape(body)) {
    // A 2xx that isn't the detail contract (gateway HTML, drift) is a fault,
    // never an empty-but-healthy page.
    return <OpsLoadFailed />
  }

  return <OpsTransferDetailView detail={body} />
}
