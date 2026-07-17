import type { Money } from './money.js'

export type QuoteStatus = 'active' | 'expired' | 'consumed'

// Puente's firm, time-boxed USD→MXN offer. Amounts are Money (integer minor
// units); the invariant totalAmount = sendAmount + feeAmount holds exactly.
// receiveAmount and fxRate are display/Reg E metadata, never ledger positions.
export interface Quote {
  id: string
  payoutDestinationId: string
  /** What the sender is debited — sendAmount + feeAmount, derived, not stored. */
  totalAmount: Money
  /** Principal delivered to the recipient (USD side). */
  sendAmount: Money
  /** Puente's fee. */
  feeAmount: Money
  /** MXN the recipient receives at the quoted rate. */
  receiveAmount: Money
  /** Customer-facing rate as a fixed 4-dp decimal string, e.g. "17.3400". */
  fxRate: string
  expiresAt: string
  status: QuoteStatus
  createdAt: string
}

export interface CreateQuoteInput {
  payoutDestinationId: string
  /** The full amount the sender will be debited (USD). */
  totalAmount: Money
}
