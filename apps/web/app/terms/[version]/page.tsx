import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import TermsDocument from '@/components/legal/TermsDocument'
import { archivedTerms, termsChrome } from '@/components/legal/terms'

type Props = { params: Promise<{ version: string }> }

// Superseded terms are served at /terms/<effective-date> so anyone who agreed
// to an older version can still read it. Only known archives resolve; anything
// else 404s rather than rendering an empty document.
export function generateStaticParams() {
  return Object.keys(archivedTerms).map((version) => ({ version }))
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { version } = await params
  if (!archivedTerms[version]) return {}
  return {
    title: `Terms of Service (${version}) | Puente Financial`,
    description: `Superseded Puente Financial Terms of Service, effective ${version}.`,
    robots: { index: false, follow: true },
  }
}

export default async function ArchivedTermsPage({ params }: Props) {
  const { version } = await params
  const docs = archivedTerms[version]
  if (!docs) notFound()

  return (
    <main className="bg-white min-h-screen">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-20">
        <Link href="/" className="text-sm text-blue-600 hover:underline inline-block mb-8">
          {termsChrome.en.backHome}
        </Link>

        <TermsDocument doc={docs.en} lang="en" id="en" jumpHref="#es" archived />

        <hr className="my-16 border-gray-200" />

        <TermsDocument doc={docs.es} lang="es" id="es" jumpHref="#en" archived />
      </div>
    </main>
  )
}
