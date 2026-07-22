import type { Metadata } from 'next'
import PrivacyContent from '@/components/legal/PrivacyContent'

export const metadata: Metadata = {
  title: 'Privacy Policy — Puente Financial',
}

export default function PrivacyPage() {
  return <PrivacyContent />
}
