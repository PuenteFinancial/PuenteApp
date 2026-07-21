'use client'

import Link from 'next/link'
import { useLanguage } from '@/components/LanguageProvider'
import LanguageToggle from '@/components/LanguageToggle'

export default function Footer() {
  const { t, lang } = useLanguage()

  return (
    <footer className="footer">
      <div className="footer-inner">
        <div>
          <Link href="/" aria-label="Puente Financial — home">
            <img src="/logo-hero.svg" alt="Puente" style={{ height: 34 }} />
          </Link>
          <p className="footer-tag">{t.footer.tagline}</p>
        </div>
        <div className="footer-right">
          <LanguageToggle variant="light" />
        </div>
      </div>
      <p className="footer-disclaimer">
        {t.footer.disclaimer[0]}
        <a href="https://www.nmlsconsumeraccess.org" target="_blank" rel="noopener noreferrer">www.nmlsconsumeraccess.org</a>
        {t.footer.disclaimer[1]}
      </p>
      <p className="footer-disclaimer">{t.footer.disclaimer2}</p>
      <div className="footer-bottom">
        <span>{t.footer.rights} · {t.footer.note}</span>
        <span>{lang === 'es' ? 'Español' : 'English'}</span>
      </div>
    </footer>
  )
}
