'use client'

import { useLanguage } from '@/components/LanguageProvider'

export default function AnnounceBanner() {
  const { t } = useLanguage()

  return (
    <div className="announce">
      <span>{t.announce.pre}</span>
      <a href="#waitlist">
        {t.announce.link}
        <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 6.5h8M7 3l3.5 3.5L7 10" />
        </svg>
      </a>
    </div>
  )
}
