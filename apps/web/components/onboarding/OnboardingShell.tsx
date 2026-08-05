import Link from 'next/link'
import type { ReactNode } from 'react'
import LanguageToggle from '@/components/LanguageToggle'

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
      {/* The language toggle lives here, not just in the marketing nav: the
          LanguageProvider defaults to Spanish, and onboarding renders outside
          the marketing chrome — so without this, /signup was Spanish-only with
          no way to switch. A2P/TCR vets the English consent copy on this page. */}
      <div style={{
        width: '100%',
        maxWidth: 480,
        marginBottom: 36,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
      }}>
        <Link href="/" aria-label="Puente Financial — home">
          <img src="/logo-dark.svg" alt="Puente" style={{ height: 34 }} />
        </Link>
        <LanguageToggle variant="light" />
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
