import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'Terms of Service — Puente Financial',
}

export default function TermsPage() {
  return (
    <main className="bg-white min-h-screen">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-20">
        <Link href="/" className="text-sm text-blue-600 hover:underline mb-8 inline-block">
          ← Back to home
        </Link>

        <h1 className="text-4xl font-bold text-gray-900 mb-2">Terms of Service</h1>
        <p className="text-sm text-gray-500 mb-10">Last updated: May 29, 2026</p>

        <div className="prose prose-gray max-w-none space-y-8 text-gray-700 leading-relaxed">
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">1. Waitlist</h2>
            <p>
              By joining the Puente Financial waitlist, you agree to receive communications about
              our product development and launch. Joining the waitlist does not guarantee access to
              any product or service. Puente Financial is a pre-launch company and no financial
              products are currently available.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">2. No Financial Services</h2>
            <p>
              Puente Financial does not currently offer any financial products, credit cards, money
              transfer services, or credit reporting services. All descriptions of future products
              on this website are forward-looking and subject to change. Nothing on this website
              constitutes a financial offer or commitment.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">3. Accuracy of Information</h2>
            <p>
              We strive to provide accurate information about our planned products, but descriptions
              of features, pricing, rewards, and other product details are subject to change prior
              to launch and should not be relied upon as definitive.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">4. Limitation of Liability</h2>
            <p>
              Puente Financial shall not be liable for any damages arising from your use of or
              reliance on this website or its content. This website is provided "as is" without
              warranties of any kind.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">5. Contact</h2>
            <p>
              For questions about these terms, contact us at{' '}
              <a href="mailto:legal@puentefinancial.com" className="text-blue-600 hover:underline">
                legal@puentefinancial.com
              </a>
              .
            </p>
          </section>
        </div>
      </div>
    </main>
  )
}
