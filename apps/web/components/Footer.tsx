'use client'

import Link from 'next/link'
import { useLanguage } from '@/components/LanguageProvider'
import LanguageToggle from '@/components/LanguageToggle'

export default function Footer() {
  const { t, lang } = useLanguage()

  return (
    <footer className="footer">
      <div className="footer-top">
        <Link href="/" aria-label="Puente Financial — home">
          <img src="/logo-hero.svg" alt="Puente" width={93} height={34} />
        </Link>
        <LanguageToggle variant="light" />
      </div>
      <div className="footer-body">
        <p className="footer-tag">{t.footer.tagline}</p>
        <div className="footer-legal-links">
          <Link href="/privacy">{t.footer.privacyLink}</Link>
          <Link href="/terms">{t.footer.termsLink}</Link>
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
