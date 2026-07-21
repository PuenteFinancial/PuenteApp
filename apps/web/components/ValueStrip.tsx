'use client'

import { useLanguage } from '@/components/LanguageProvider'

const ICONS = [
  /* id card */
  <svg key="id" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>,
  /* report / list */
  <svg key="bureaus" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="14" y2="18"/></svg>,
  /* clock */
  <svg key="setup" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>,
  /* no card */
  <svg key="nocard" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="3" y1="18" x2="21" y2="6"/></svg>,
]

export default function ValueStrip() {
  const { t } = useLanguage()
  const items = [t.hero.elig, ...t.hero.pills]

  return (
    <div className="vstrip">
      <div className="vstrip-inner">
        {items.map((label, i) => (
          <span key={i} className="vstrip-item">
            <span className="vi">{ICONS[i]}</span>
            {label}
          </span>
        ))}
      </div>
    </div>
  )
}
