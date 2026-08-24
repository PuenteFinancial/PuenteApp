import type { Metadata } from 'next'
import { notFound, redirect } from 'next/navigation'
import { apiFetch, getSessionToken, refreshRedirectPath } from '@/lib/session'
import { isOpsOverviewShape } from '@/lib/opsOverview'
import OpsOverviewView from '@/components/ops/OpsOverviewView'
import OpsLoadFailed from '@/components/ops/OpsLoadFailed'

export const metadata: Metadata = {
  title: 'Operations | Puente Financial',
  robots: { index: false },
}

// The 8.5-v1 read-only ops board. Deliberately NO nav entry and no dashboard
// probe: this page is reached by direct URL only, and the real gate is the
// API's OPS_ADMIN_USER_IDS allowlist — a non-admin's fetch 404s and this page
// renders Next's stock not-found, indistinguishable from a route that does not
// exist. Accepted, documented leak: an unauthenticated prober gets the
// session-refresh redirect (proving a WEB route exists here) — making that
// path 404 would strand a real admin with an expired cookie, and the secret is
// the data + API surface, both behind the API 404.
export default async function OpsPage() {
  const token = await getSessionToken()
  if (!token) redirect(refreshRedirectPath('/dashboard/ops'))

  const res = await apiFetch('/v1/ops/overview', token)
  if (res.status === 401) redirect(refreshRedirectPath('/dashboard/ops'))
  if (res.status === 404) notFound()

  if (!res.ok) {
    return (
        <OpsLoadFailed />
    )
  }

  const body = (await res.json().catch(() => null)) as unknown
  if (!isOpsOverviewShape(body)) {
    // A 2xx that isn't the overview contract (gateway HTML, drift) is a fault,
    // never an empty-but-healthy ops board.
    return (
        <OpsLoadFailed />
    )
  }

  return (
      <OpsOverviewView overview={body} />
  )
}
