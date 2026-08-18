import type { ReactNode } from 'react'
import DashboardShell from '@/components/DashboardShell'

// Every /dashboard screen renders inside the shared shell (#202). Pages no
// longer wrap themselves — auth/KYC gating stays per-page (each page still
// redirects unauthenticated sessions; a layout cannot, reliably, on
// client-side navigations).
export default function DashboardLayout({ children }: { children: ReactNode }) {
  return <DashboardShell>{children}</DashboardShell>
}
