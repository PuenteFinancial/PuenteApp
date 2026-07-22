import { env } from '../../config/env.js'
import { MockFundingProcessor } from './mock.js'

export type FundingEventType =
  | 'funding_succeeded'
  | 'funding_failed'
  | 'funding_cleared'
  | 'funding_reversed'

export interface FundingEvent {
  /** Processor-unique event id (Stripe: evt_…; mock: caller-supplied). */
  eventId: string
  type: FundingEventType
  /** Our transfers.id, echoed back by the processor (Stripe: from metadata). */
  transferRef: string
  /** Processor-side payment id (Stripe: payment_intent id; mock: mockpay_…). */
  paymentRef: string
  /** Failure / ACH return code on funding_failed | funding_reversed. */
  reason?: string
}

export interface FundingInitiation {
  provider: string
  method: 'ach'
  /** Persisted to transfers.funding_payment_ref. */
  paymentRef: string
  /** Processor-specific fields the client needs (Stripe: client_secret). */
  clientFields: Record<string, string>
}

// The result of a funding-undo op (slice 6). Persisted to
// transfers.refund_payment_ref (one undo path per transfer). `pending` is for a
// real async return (Stripe ACH refund); the mock void/refund is always
// `succeeded` (instant), which is what lets PR1's cancel run synchronously.
export interface FundingUndo {
  provider: string
  /** Processor-side undo id (Stripe: canceled PaymentIntent / Refund id; mock: mockvoid_… / mockrefund_…). */
  ref: string
  status: 'succeeded' | 'pending'
}

// The seam Stripe drops into (slice 4b): initiation on confirm, plus the
// webhook-side verify + normalize. Implementations never throw from
// verifySignature; parseEvent returns null for anything unusable.
export interface FundingProcessor {
  readonly provider: string
  initiateFunding(input: {
    transferId: string
    userId: string
    totalAmountMinor: number
    currency: 'USD'
  }): Promise<FundingInitiation>
  verifySignature(rawBody: Buffer, signatureHeader: string): boolean
  parseEvent(rawBody: Buffer): FundingEvent | null
  // The two funding-undo ops (slice 6), mirroring the initiateFunding seam.
  // Distinct money movements → distinct ledger batches: voidFunding cancels an
  // UNCLEARED pull (Stripe: cancel the PaymentIntent) so nothing ever settled —
  // the cancel-at-FUNDED path; refund returns COLLECTED funds (Stripe: create a
  // Refund) — the PAYOUT_FAILED→REFUNDED path. Both accept an idempotencyKey so
  // the slice-7 Stripe adapter drops in exactly-once without a signature change
  // (PR1 calls voidFunding; PR2 calls refund).
  voidFunding(input: {
    transferId: string
    paymentRef: string
    idempotencyKey: string
  }): Promise<FundingUndo>
  refund(input: {
    transferId: string
    paymentRef: string
    amountMinor: number
    currency: 'USD'
    idempotencyKey: string
  }): Promise<FundingUndo>
}

// No DI container in this codebase (services are plain modules, bridge.ts
// style) — a module-level factory on env is the established seam shape.
const processors: Record<typeof env.FUNDING_PROCESSOR, () => FundingProcessor> = {
  mock: () => new MockFundingProcessor(),
}

let instance: FundingProcessor | undefined

export function getFundingProcessor(): FundingProcessor {
  instance ??= processors[env.FUNDING_PROCESSOR]()
  return instance
}
