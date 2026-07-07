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
      {children}
    </main>
  )
}
