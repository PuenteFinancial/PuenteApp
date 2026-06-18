'use client'

import { useLanguage } from '@/components/LanguageProvider'

export default function HowItWorksSection() {
  const { t } = useLanguage()
  const h = t.how

  return (
    <section id="how" className="section section--surface">
      <div className="section-inner">
        <div className="how-head">
          <span className="eyebrow">{h.eyebrow}</span>
          <h2 className="h2">
            {h.h2.map((pair, i) => (
              <span key={i}>
                {pair[0]}
                <span className="accent">{pair[1]}</span>
              </span>
            ))}
          </h2>
          <p className="lede">{h.sub}</p>
        </div>

        <div className="how-steps">
          {h.steps.map((step, i) => (
            <div className="how-step" key={i}>
              <span className="how-num">{i + 1}</span>
              <h3 className="h3">{step.t}</h3>
              <p>{step.d}</p>
            </div>
          ))}
        </div>

        <div className="how-foot">
          <div className="how-privacy">
            <span className="hp-ic">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="4" y="11" width="16" height="9" rx="2" />
                <path d="M8 11V8a4 4 0 0 1 8 0v3" />
              </svg>
            </span>
            <span className="hp-txt">
              <b>{h.privacyTitle}</b>
              {h.privacy}
            </span>
          </div>
          <div className="how-side">
            <div className="need">
              <span className="nic">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="5" width="18" height="14" rx="2" />
                  <path d="M3 10h18" />
                </svg>
              </span>
              <span className="ntxt">
                <b>{h.eligTitle}</b>
                {h.elig}
              </span>
            </div>
            <a className="btn btn--ink btn--lg" href="/signup">{h.cta}</a>
          </div>
        </div>
      </div>
    </section>
  )
}
