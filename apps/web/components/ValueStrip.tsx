'use client'

import { useLanguage } from '@/components/LanguageProvider'

const ICONS = [
  /* dollar */
  <svg key="fee" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="2" x2="12" y2="22"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>,
  /* trending up */
  <svg key="rate" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>,
  /* id card */
  <svg key="id" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>,
  /* users */
  <svg key="newcomers" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>,
]

export default function ValueStrip() {
  const { t } = useLanguage()
  const items = [t.hero.notes[0], t.hero.notes[1], t.hero.elig, t.hero.notes[2]]

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
