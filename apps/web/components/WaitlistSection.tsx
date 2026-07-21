'use client'

import { useLanguage } from '@/components/LanguageProvider'

export default function WaitlistSection() {
  const { t } = useLanguage()
  const s = t.wl

  return (
    <section id="waitlist" className="waitlist">
      <div className="wl-inner">
        <span className="eyebrow">{s.eyebrow}</span>
        <h2 className="h2">{s.h2}</h2>
        <div className="wl-highlight">
          <p className="lede">🎉 {s.sub[0]}<b>{s.sub[1]}</b>{s.sub[2]}</p>
          <p className="wl-highlight-fine">{s.subFine}</p>
        </div>
        <ul className="wl-points">
          {s.points.map((p, i) => (
            <li key={i}>
              <span className="tick">✓</span>
              <span>{p}</span>
            </li>
          ))}
        </ul>
        <a className="btn btn--accent btn--lg" href="/waitlist">{s.cta}</a>
      </div>
    </section>
  )
}
