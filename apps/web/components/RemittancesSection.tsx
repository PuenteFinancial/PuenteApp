'use client'

import { useLanguage } from '@/components/LanguageProvider'
import Calculator from '@/components/Calculator'

export default function RemittancesSection() {
  const { t } = useLanguage()

  return (
    <section id="remittances" className="section section--body">
      <div className="section-inner">
        <div className="feature">
          <div className="feature-copy">
            <span className="eyebrow">{t.remit.eyebrow}</span>
            <h2 className="h2">{t.remit.h2}</h2>
            <p className="lede">{t.remit.sub}</p>
          </div>
          <div className="feature-media" style={{ display: 'flex', justifyContent: 'center' }}>
            <Calculator />
          </div>
        </div>
      </div>
    </section>
  )
}
