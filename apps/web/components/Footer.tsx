'use client'

import { useLanguage } from '@/components/LanguageProvider'
import LanguageToggle from '@/components/LanguageToggle'

export default function Footer() {
  const { t, lang } = useLanguage()

  return (
    <footer className="footer">
      <div className="footer-inner">
        <div>
          <a href="/" aria-label="Puente Financial — home">
            <img src="/logo-hero.svg" alt="Puente" style={{ height: 34 }} />
          </a>
          <p className="footer-tag">{t.footer.tagline}</p>
        </div>
        <div className="footer-right">
          <LanguageToggle variant="light" />
        </div>
      </div>
      <div className="footer-bottom">
        <span>{t.footer.rights} · {t.footer.note}</span>
        <span>{lang === 'es' ? 'Español' : 'English'}</span>
      </div>
    </footer>
  )
}
