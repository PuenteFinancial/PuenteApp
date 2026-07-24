import Link from 'next/link'
import type { ReactNode } from 'react'

export default function OnboardingShell({ children }: { children: ReactNode }) {
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
        marginBottom: 36,
      }}>
        <Link href="/" aria-label="Puente Financial — home">
          <img src="/logo-dark.svg" alt="Puente" style={{ height: 34 }} />
        </Link>
      </div>
      {/* .wl-card sets no width, and a centered column flex item is sized by its
          content — so any card with a long paragraph (the Reg E disclosure, the
          cancellation-support notice) stretched to the full viewport, running
          legally-operative copy out to ~1100px line lengths. Constraining here
          rather than per-card keeps every onboarding screen the same width. */}
      <div style={{ width: '100%', maxWidth: 480 }}>{children}</div>
    </main>
  )
}
