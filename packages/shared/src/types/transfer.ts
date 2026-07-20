import type { Money } from './money.js'

// The 11 states of docs/transfer-state-machine.md. Terminal: PAYMENT_FAILED,
// REFUNDED, COMPLETED (dispute window aside), FUNDING_REVERSED. Transitions
// happen only through the transition_transfer RPC — never a bare update.
export type TransferState =
  | 'PENDING_PAYMENT'
  | 'FUNDED'
  | 'SUBMITTED'
  | 'IN_FLIGHT'
  | 'COMPLETED'
  | 'PAYMENT_FAILED'
  | 'CANCELED'
  | 'PAYOUT_FAILED'
  | 'REFUNDED'
  | 'FUNDING_REVERSED'
  | 'UNDER_REVIEW'

export type DisclosureType = 'prepayment' | 'receipt'
export type DisclosureLocale = 'en' | 'es'

// What POST /v1/transfers returns alongside the transfer — enough for the
// client to display/accept; full content is available on the transfer detail.
export interface DisclosureSummary {
  id: string
  type: DisclosureType
  locale: DisclosureLocale
  presentedAt: string
}

// Processor-neutral funding instructions returned by confirm. clientFields
// carries whatever the active processor's client SDK needs (Stripe: a
// client_secret; mock: empty).
export interface FundingDetails {
  provider: string
  method: 'ach'
  clientFields: Record<string, string>
}

// A transfer's terms are snapshots copied from the quote at creation and are
// immutable from then on; the invariant totalAmount = sendAmount + feeAmount
// holds exactly. receiveAmount/fxRate remain display/Reg E metadata.
export interface Transfer {
  id: string
  quoteId: string
  payoutDestinationId: string
  state: TransferState
  totalAmount: Money
  sendAmount: Money
  feeAmount: Money
  receiveAmount: Money
  /** Customer-facing rate as a fixed 4-dp decimal string, e.g. "17.3400". */
  fxRate: string
  fundingSourceType: 'ach'
  fundingCleared: boolean
  disclosureAcceptedAt: string | null
  /** Set at FUNDED — starts the Reg E cancellation clock. */
  paymentAt: string | null
  cancelableUntil: string | null
  completedAt: string | null
  createdAt: string
}

export interface CreateTransferInput {
  quoteId: string
}

export interface ConfirmTransferInput {
  disclosureId: string
  /** Must be literally true — declining is just not confirming. */
  accepted: true
}
