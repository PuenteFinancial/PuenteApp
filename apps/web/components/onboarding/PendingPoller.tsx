'use client'

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'

// Invisible companion to the pending StatusCard: checks KYC status every
// 30 s (and when the tab regains focus — returning from the Persona tab is
// the common case) and hands off to /continue, the single routing brain,
// the moment the user is no longer pending. On 401 it also goes to
// /continue: with no session there, the silent-refresh hop takes over and
// routes by state. Errors just wait for the next tick — never dead-end.
const POLL_INTERVAL_MS = 30_000
const PARKED_STATUSES = ['pending', 'manual_review']

export default function PendingPoller() {
  const router = useRouter()
  const inFlight = useRef(false)

  useEffect(() => {
    let cancelled = false

    const check = async () => {
      if (inFlight.current) return
      inFlight.current = true
      try {
        const res = await fetch('/api/users/me', { cache: 'no-store' })
        if (cancelled) return
        if (res.status === 401) {
          router.replace('/continue')
          return
        }
        if (!res.ok) return
        const { kycStatus } = (await res.json()) as { kycStatus?: string }
        if (cancelled) return
        if (kycStatus && !PARKED_STATUSES.includes(kycStatus)) {
          router.replace('/continue')
        }
      } catch {
        // transient network failure — retry on the next tick
      } finally {
        inFlight.current = false
      }
    }

    const interval = setInterval(check, POLL_INTERVAL_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') void check()
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      cancelled = true
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [router])

  return null
}
