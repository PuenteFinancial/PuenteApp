'use client'

import type { Lang } from '@/lib/translations'

// Local language toggle for the legal pages. Deliberately NOT wired to the
// site-wide LanguageProvider: the canonical /privacy and /terms URLs must
// render English by default in SSR (that is the URL registered for A2P 10DLC
// vetting, whose scanner reads the server HTML). Users can switch to Spanish
// here without changing the SSR default.
export default function LegalLangToggle({
  lang,
  setLang,
}: {
  lang: Lang
  setLang: (lang: Lang) => void
}) {
  return (
    <span className="lang lang--light">
      <button
        className={lang === 'es' ? 'is-active' : ''}
        onClick={() => setLang('es')}
        aria-label="Español"
      >
        ES
      </button>
      <button
        className={lang === 'en' ? 'is-active' : ''}
        onClick={() => setLang('en')}
        aria-label="English"
      >
        EN
      </button>
    </span>
  )
}
