'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useLanguage } from '@/components/LanguageProvider'
import LanguageToggle from '@/components/LanguageToggle'

export default function Nav() {
  const { t } = useLanguage()
  const [scrolled, setScrolled] = useState(false)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const handler = () => setScrolled(window.scrollY > 10)
    window.addEventListener('scroll', handler, { passive: true })
    return () => window.removeEventListener('scroll', handler)
  }, [])

  const close = () => setOpen(false)

  return (
    <>
      <nav className={`nav${scrolled ? ' nav--scrolled' : ''}`}>
        <div className="nav-inner">
          <Link href="/" aria-label="Puente Financial — home">
            <img src="/logo-hero.svg" alt="Puente" className="nav-logo" />
          </Link>
          <div className="nav-links">
            <a href="#remittances">{t.nav.remit}</a>
            <a href="#how">{t.nav.how}</a>
            <a href="/signup">{t.nav.signIn}</a>
          </div>
          <div className="nav-right">
            <LanguageToggle />
            <a className="btn btn--accent btn--sm" href="/waitlist">{t.nav.cta}</a>
            <button className="nav-menu-btn" onClick={() => setOpen(true)} aria-label="Open menu">
              <span />
              <span />
              <span />
            </button>
          </div>
        </div>
      </nav>

      {open && <div className="nav-overlay" onClick={close} />}

      <div className={`nav-drawer${open ? ' nav-drawer--open' : ''}`} aria-hidden={!open}>
        <button className="nav-drawer-close" onClick={close} aria-label="Close menu">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
        <a href="#remittances" onClick={close}>{t.nav.remit}</a>
        <a href="#how" onClick={close}>{t.nav.how}</a>
        <a href="/signup" onClick={close}>{t.nav.signIn}</a>
        <a className="btn btn--accent" href="/waitlist" style={{ marginTop: 16 }}>{t.nav.cta}</a>
      </div>
    </>
  )
}
