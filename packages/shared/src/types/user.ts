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
