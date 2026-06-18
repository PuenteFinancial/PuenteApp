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
        <p className="lede">{s.sub}</p>
        <ul className="wl-points">
          {s.points.map((p, i) => (
            <li key={i}>
              <span className="tick">✓</span>
              <span>{p}</span>
            </li>
          ))}
        </ul>
        <a className="btn btn--accent btn--lg" href="/signup">{s.cta}</a>
      </div>
    </section>
  )
}
