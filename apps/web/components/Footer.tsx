'use client'

import Link from 'next/link'
import { useLanguage } from '@/components/LanguageProvider'
import LanguageToggle from '@/components/LanguageToggle'

export default function Footer() {
  const { t, lang } = useLanguage()
  const d = t.footer.disclosures

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
        {d.entity[0]}
        <a href="https://www.nmlsconsumeraccess.org" target="_blank" rel="noopener noreferrer">www.nmlsconsumeraccess.org</a>
        {d.entity[1]}
        <a href="https://stripe.com/spc/licenses" target="_blank" rel="noopener noreferrer">stripe.com/spc/licenses</a>
        {d.entity[2]}
      </p>
      <p className="footer-disclaimer">{d.fincen}</p>
      <p className="footer-disclaimer">{d.fdic}</p>
      <p className="footer-disclaimer">{d.creditRepair}</p>
      <p className="footer-disclaimer">{d.results}</p>
      <div className="footer-bottom">
        <span>{t.footer.rights}</span>
        <span>{lang === 'es' ? 'Español' : 'English'}</span>
      </div>
    </footer>
  )
}
