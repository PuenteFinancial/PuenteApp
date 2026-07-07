import type { Metadata } from 'next'
import Link from 'next/link'
import SignupFlow from '@/components/SignupFlow'

export const metadata: Metadata = {
  title: 'Join the Waitlist — Puente Financial',
  description: 'Join the Puente waitlist. Send money home and build your U.S. credit history.',
}

export default function WaitlistPage() {
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
      <SignupFlow />
    </main>
  )
}
