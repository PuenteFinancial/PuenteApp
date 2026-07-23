'use client'

import { useState } from 'react'
import Link from 'next/link'
import type { Lang } from '@/lib/translations'
import LegalLangToggle from './LegalLangToggle'
import { termsCopy } from './content'

const EMAIL = 'legal@puentefinancial.com'

export default function TermsContent() {
  // Default to English so the canonical /terms URL renders English in SSR.
  // Spanish is available via the toggle.
  const [lang, setLang] = useState<Lang>('en')
  const c = termsCopy[lang]

  return (
    <main className="bg-white min-h-screen">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-20">
        <div className="flex items-center justify-between gap-4 mb-8">
          <Link href="/" className="text-sm text-blue-600 hover:underline inline-block">
            {c.backHome}
          </Link>
          <LegalLangToggle lang={lang} setLang={setLang} />
        </div>

        <h1 className="text-4xl font-bold text-gray-900 mb-2">{c.title}</h1>
        <p className="text-sm text-gray-500 mb-10">{c.updated}</p>

        <div className="prose prose-gray max-w-none space-y-8 text-gray-700 leading-relaxed">
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">{c.s1.h}</h2>
            <p>{c.s1.body}</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">{c.s2.h}</h2>
            <p>{c.s2.body}</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">{c.s3.h}</h2>
            <p>{c.s3.body}</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">{c.s4.h}</h2>
            <p>{c.s4.body}</p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">{c.s5.h}</h2>
            <p>
              {c.s5.pre}{' '}
              <Link href="/privacy" className="text-blue-600 hover:underline">
                {c.s5.privacyLink}
              </Link>{' '}
              {c.s5.post}
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">{c.s6.h}</h2>
            <p>
              {c.s6.pre}{' '}
              <a href={`mailto:${EMAIL}`} className="text-blue-600 hover:underline">
                {EMAIL}
              </a>
              .
            </p>
          </section>
        </div>
      </div>
    </main>
  )
}
