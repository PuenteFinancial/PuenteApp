import type { KycStatus } from './kyc.js'

export type PreferredLanguage = 'en' | 'es'

export type UserStatus = 'waitlist' | 'active' | 'suspended'

export interface User {
  id: string
  phone: string
  email: string
  firstName: string
  lastName: string
  preferredLanguage: PreferredLanguage
  status: UserStatus
  fcraConsentAt: string | null   // ISO timestamp — null = consent not given
  bridgeCustomerId: string | null
  kycStatus: KycStatus
  emailVerifiedAt: string | null
  // K2 sender address (US-only MVP) — null until the profile step collects it.
  // PII: never logged, never in URL params.
  addressLine1: string | null
  addressLine2: string | null
  addressCity: string | null
  addressState: string | null
  addressPostalCode: string | null
  createdAt: string
  updatedAt: string
}

export interface CreateUserInput {
  phone: string
  email: string
  firstName: string
  lastName: string
  preferredLanguage: PreferredLanguage
}
