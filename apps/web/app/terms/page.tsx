import type { Metadata } from 'next'
import Link from 'next/link'
import TermsDocument from '@/components/legal/TermsDocument'
import { currentTerms, termsChrome } from '@/components/legal/terms'

export const metadata: Metadata = {
  title: 'Terms of Service | Puente Financial',
  description:
    'The Terms of Service governing your use of Puente Financial, in English and Spanish.',
}

export default function TermsPage() {
  return (
    <main className="bg-white min-h-screen">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-20">
        <Link href="/" className="text-sm text-blue-600 hover:underline inline-block mb-8">
          {termsChrome.en.backHome}
        </Link>

        <TermsDocument
          doc={currentTerms.en}
          lang="en"
          id="en"
          jumpHref="#es"
          priorVersion="2026-07-21"
        />

        <hr className="my-16 border-gray-200" />

        <TermsDocument
          doc={currentTerms.es}
          lang="es"
          id="es"
          jumpHref="#en"
          priorVersion="2026-07-21"
        />
      </div>
    </main>
  )
}
