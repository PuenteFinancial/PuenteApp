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
