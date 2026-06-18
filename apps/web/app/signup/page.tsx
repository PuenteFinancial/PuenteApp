import type { Metadata } from 'next'
import SignupFlow from '@/components/SignupFlow'

export const metadata: Metadata = {
  title: 'Sign Up — Puente Financial',
  description: 'Create your Puente account. Send money home for $5 flat and build your U.S. credit history.',
}

export default function SignupPage() {
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
        <a href="/" aria-label="Puente Financial — home">
          <img src="/logo-dark.svg" alt="Puente" style={{ height: 34 }} />
        </a>
      </div>
      <SignupFlow />
    </main>
  )
}
