'use client'

import { useLanguage } from '@/components/LanguageProvider'
import posthog from 'posthog-js'

export default function LanguageToggle({ variant }: { variant?: 'light' }) {
  const { lang, setLang } = useLanguage()

  return (
    <span className={variant === 'light' ? 'lang lang--light' : 'lang'}>
      <button
        className={lang === 'es' ? 'is-active' : ''}
        onClick={() => {
          if (lang !== 'es') posthog.capture('language_switched', { from: lang, to: 'es' })
          setLang('es')
        }}
        aria-label="Español"
      >
        ES
      </button>
      <button
        className={lang === 'en' ? 'is-active' : ''}
        onClick={() => {
          if (lang !== 'en') posthog.capture('language_switched', { from: lang, to: 'en' })
          setLang('en')
        }}
        aria-label="English"
      >
        EN
      </button>
    </span>
  )
}
