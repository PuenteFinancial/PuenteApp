import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'Privacy Policy — Puente Financial',
}

export default function PrivacyPage() {
  return (
    <main className="bg-white min-h-screen">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-20">
        <Link href="/" className="text-sm text-blue-600 hover:underline mb-8 inline-block">
          ← Back to home
        </Link>

        <h1 className="text-4xl font-bold text-gray-900 mb-2">Privacy Policy</h1>
        <p className="text-sm text-gray-500 mb-10">Last updated: May 29, 2026</p>

        <div className="prose prose-gray max-w-none space-y-8 text-gray-700 leading-relaxed">
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">1. Information We Collect</h2>
            <p>
              When you join our waitlist, we collect your first name, WhatsApp number, estimated
              monthly send amount, and destination country. We also collect standard web analytics
              data such as your browser type and general location.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">2. How We Use Your Information</h2>
            <p>
              We use the information you provide solely to contact you about Puente Financial product
              updates, early access, and launch announcements. We will not sell or share your personal
              information with third parties for marketing purposes.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">3. Data Storage</h2>
            <p>
              Your information is stored securely using Supabase, a SOC 2 compliant database
              platform. We retain your data for as long as necessary to operate our waitlist and
              communicate with you about our product.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">4. Your Rights</h2>
            <p>
              You may request that we delete your information at any time by emailing us at{' '}
              <a href="mailto:privacy@puentefinancial.com" className="text-blue-600 hover:underline">
                privacy@puentefinancial.com
              </a>
              . We will process your request within 30 days.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">5. Contact</h2>
            <p>
              For any questions about this policy, please contact us at{' '}
              <a href="mailto:privacy@puentefinancial.com" className="text-blue-600 hover:underline">
                privacy@puentefinancial.com
              </a>
              .
            </p>
          </section>
        </div>
      </div>
    </main>
  )
}
