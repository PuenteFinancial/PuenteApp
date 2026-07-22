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
        <p className="text-sm text-gray-500 mb-10">Last updated: July 21, 2026</p>

        <div className="prose prose-gray max-w-none space-y-8 text-gray-700 leading-relaxed">
          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">1. Information We Collect</h2>
            <p>
              When you join our waitlist, we collect your first name, WhatsApp number, estimated
              monthly send amount, and destination country. When you create an account or sign in,
              we collect your mobile phone number so we can send one-time verification codes by SMS
              (see &ldquo;SMS / Text Messaging&rdquo; below). We also collect standard web analytics
              data such as your browser type and general location.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">2. How We Use Your Information</h2>
            <p>
              We use the information you provide to operate Puente Financial, to communicate with you
              about product updates and launch announcements, and to verify your identity and secure
              your account &mdash; including sending one-time verification codes by SMS. We will not
              sell or share your personal information with third parties for marketing purposes.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">3. SMS / Text Messaging</h2>
            <p>
              When you create an account or sign in to the Puente Financial mobile app, we send a
              one-time verification code (OTP) by text message to the mobile number you provide, to
              confirm it belongs to you. By entering your number and requesting a code, you consent
              to receive these transactional SMS messages from Puente Financial.
            </p>
            <ul className="list-disc pl-6 space-y-2 mt-3">
              <li>
                <strong>Message frequency:</strong> You receive a message only when you request a
                verification code; frequency varies with how often you sign in.
              </li>
              <li>
                <strong>Message and data rates may apply,</strong> depending on your mobile carrier
                and plan.
              </li>
              <li>
                <strong>Opt-out:</strong> Reply STOP to any message to opt out of SMS, or HELP for
                help. Because these codes are required to access your account, opting out may prevent
                you from signing in.
              </li>
              <li>
                <strong>No sharing of mobile data:</strong> We do not share, sell, rent, or
                otherwise provide your mobile phone number, SMS opt-in, or messaging consent to any
                third parties or affiliates for marketing or promotional purposes. We use a messaging
                service provider solely to deliver your verification codes; this information is never
                used for marketing or promotional purposes.
              </li>
            </ul>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">4. Data Storage</h2>
            <p>
              Your information is stored securely using Supabase, a SOC 2 compliant database
              platform. We retain your data for as long as necessary to operate our waitlist and
              communicate with you about our product.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">5. Your Rights</h2>
            <p>
              You may request that we delete your information at any time by emailing us at{' '}
              <a href="mailto:privacy@puentefinancial.com" className="text-blue-600 hover:underline">
                privacy@puentefinancial.com
              </a>
              . We will process your request within 30 days.
            </p>
          </section>

          <section>
            <h2 className="text-xl font-semibold text-gray-900 mb-3">6. Contact</h2>
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
