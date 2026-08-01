'use client'

// Retryable failure state for the ops board (server component can't own the
// reload click). A refresh re-runs the whole server fetch.
import { useLanguage } from '@/components/LanguageProvider'
import { useRouter } from 'next/navigation'

export default function OpsLoadFailed() {
  const { t } = useLanguage()
  const router = useRouter()
  return (
    <div>
      <p style={{ fontSize: 14, color: 'var(--muted)' }}>{t.ops.loadFailed}</p>
      <button type="button" className="btn btn--ghost btn--sm" onClick={() => router.refresh()}>
        {t.ops.retry}
      </button>
    </div>
  )
}
