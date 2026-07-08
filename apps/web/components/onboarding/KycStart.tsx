'use client'

import { useState } from 'react'
import { useLanguage } from '@/components/LanguageProvider'

const BRIDGE_TOS_URL = 'https://dashboard.bridge.xyz/accept-terms-of-service'

export default function KycStart() {
  const { t } = useLanguage()
  const s = t.onboarding.kyc
  const [starting, setStarting] = useState(false)

  const handleStart = () => {
    setStarting(true)
    const returnUrl = `${window.location.origin}/onboarding/kyc/tos-return`
    window.location.href = `${BRIDGE_TOS_URL}?redirect_uri=${encodeURIComponent(returnUrl)}`
  }

  return (
    <div className="wl-card">
      <h1 style={{ fontFamily: 'var(--font)', fontSize: 24, fontWeight: 700, margin: '0 0 8px', color: 'var(--ink)' }}>
        {s.title}
      </h1>
      <p style={{ fontSize: 15, color: 'var(--muted)', margin: '0 0 16px', lineHeight: 1.6 }}>{s.body}</p>
      {/* GLBA: disclose the data hand-off to Bridge before the user continues */}
      <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 24px', lineHeight: 1.5 }}>
        {s.dataNotice}
      </p>

      <button
        className="btn btn--accent"
        type="button"
        onClick={handleStart}
        disabled={starting}
        style={{ width: '100%', fontSize: 17, padding: '17px 28px' }}
      >
        {starting ? s.starting : s.cta}
      </button>
    </div>
  )
}
