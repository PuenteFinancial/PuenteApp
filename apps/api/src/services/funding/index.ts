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
