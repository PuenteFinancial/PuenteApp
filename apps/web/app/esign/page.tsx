import type { Metadata } from 'next'
import EsignContent from '@/components/legal/EsignContent'

export const metadata: Metadata = {
  title: 'E-SIGN Consent | Puente Financial',
}

export default function EsignPage() {
  return <EsignContent />
}
