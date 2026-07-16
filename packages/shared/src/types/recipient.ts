export type RecipientStatus = 'active' | 'archived'

export type PayoutMethod = 'bank_account' | 'wallet' | 'cash_pickup' | 'debit_card'

export type VerificationStatus = 'unverified' | 'verified' | 'failed'

export interface Recipient {
  id: string
  firstName: string
  lastName: string        // both surnames, verbatim — never split or derived
  relationship: string
  country: string         // ISO-3166 alpha-2
  status: RecipientStatus
  createdAt: string
  updatedAt: string
}

// The wire shape deliberately has no field that could carry a full account
// number: sensitive details stay encrypted server-side and only a masked
// display form ever crosses the API boundary.
export interface PayoutDestinationDetails {
  clabeLast4?: string
}

export interface PayoutDestination {
  id: string
  recipientId: string
  method: PayoutMethod
  currency: string        // display metadata, never a ledger position
  details: PayoutDestinationDetails
  label: string | null
  status: RecipientStatus
  verificationStatus: VerificationStatus
  createdAt: string
  updatedAt: string
}

export interface CreateRecipientInput {
  firstName: string
  lastName: string
  relationship: string
  country: string
}

export interface CreateDestinationInput {
  method: PayoutMethod
  currency: string
  details: { clabe: string }
  label?: string
}

export interface RecipientListResponse {
  data: Recipient[]
  nextCursor: string | null
}
