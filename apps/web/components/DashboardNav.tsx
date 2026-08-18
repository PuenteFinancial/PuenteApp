'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useLanguage } from '@/components/LanguageProvider'

// The persistent dashboard nav (#202) — the structural fix for the dead-end
// family (#194, #200, #201): every /dashboard screen shares this chrome, so
// no screen needs its own back link and none can strand the user again.
const LINKS = [
  { href: '/dashboard/send', key: 'send' },
  { href: '/dashboard/transfers', key: 'transfers' },
  { href: '/dashboard/recipients', key: 'recipients' },
] as const

export default function DashboardNav() {
  const { t } = useLanguage()
  const pathname = usePathname()

  return (
    <nav
      aria-label="Dashboard"
      // flexWrap: the Spanish labels (Transferencias / Destinatarios) overflow
      // a 375px viewport on one row — verified live; the third link wraps
      // rather than clips.
      style={{ display: 'flex', flexWrap: 'wrap', gap: 8, width: '100%', maxWidth: 480, marginBottom: 24 }}
    >
      {LINKS.map(({ href, key }) => {
        // /dashboard/send/<id> keeps "Send money" active — the tracker is part
        // of the send flow, not a fourth section.
        const active = pathname === href || pathname.startsWith(`${href}/`)
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={active ? 'btn btn--accent btn--sm' : 'btn btn--ghost btn--sm'}
          >
            {t.dashNav[key]}
          </Link>
        )
      })}
    </nav>
  )
}
