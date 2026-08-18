import Link from 'next/link'
import type { ReactNode } from 'react'
import LanguageToggle from '@/components/LanguageToggle'
import DashboardNav from '@/components/DashboardNav'

// The signed-in shell (#202), rendered by app/dashboard/layout.tsx around
// every /dashboard screen. Same column and chrome as OnboardingShell — the
// differences are deliberate: the logo goes to /dashboard (not the marketing
// site), and a persistent nav row replaces the per-screen back links that
// kept going missing (#194, #200, #201).
export default function DashboardShell({ children }: { children: ReactNode }) {
  return (
    <main style={{
      minHeight: '100vh',
      background: 'var(--body)',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      padding: '40px 20px 80px',
    }}>
      <div style={{
        width: '100%',
        maxWidth: 480,
        marginBottom: 24,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
      }}>
        <Link href="/dashboard" aria-label="Puente — dashboard">
          <img src="/logo-dark.svg" alt="Puente" style={{ height: 34 }} />
        </Link>
        <LanguageToggle variant="light" />
      </div>
      <DashboardNav />
      {/* Same width constraint as OnboardingShell, same reason: a centered
          column flex item is sized by its content, and long legal copy must
          not stretch to viewport width. */}
      <div style={{ width: '100%', maxWidth: 480 }}>{children}</div>
    </main>
  )
}
