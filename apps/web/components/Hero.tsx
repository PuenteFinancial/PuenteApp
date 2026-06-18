'use client'

import { useLanguage } from '@/components/LanguageProvider'

export default function Hero() {
  const { t } = useLanguage()

  return (
    <header className="hero">
      <div className="hero-inner">
        <div className="hero-copy">
          <span className="eyebrow">{t.hero.eyebrow}</span>
          <h1 className="h1">
            {t.hero.h1.map((pair, i) => (
              <span key={i} style={{ display: 'block' }}>
                {pair[0]}{' '}
                <span className="accent">{pair[1]}</span>
              </span>
            ))}
          </h1>
          <p className="lede">{t.hero.sub}</p>
          <div className="hero-cta">
            <a className="btn btn--accent btn--lg" href="/signup">{t.hero.cta1}</a>
            <a className="btn btn--ghost-light btn--lg" href="#remittances">{t.hero.cta2} →</a>
          </div>
          <span className="hero-elig">
            <span className="idot">ID</span>
            {t.hero.elig}
          </span>
          <div className="hero-note">
            {t.hero.notes.map((note, i) => (
              <span key={i}>
                <span className="dot" />
                {note}
              </span>
            ))}
          </div>
        </div>
        <div className="hero-visual">
          <span className="hero-glow" />
          <img src="/190shots_so.png" alt="Puente app" className="hero-phone-img" width={1080} height={1920} fetchPriority="high" />
        </div>
      </div>
    </header>
  )
}
