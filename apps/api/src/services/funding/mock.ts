import crypto from 'node:crypto'
import { env } from '../../config/env.js'
import type {
  FundingEventType,
  FundingInitiation,
  FundingParseResult,
  FundingProcessor,
  FundingUndo,
} from './index.js'

// Deliberately Stripe-shaped: header `t=<ms>,v1=<hex>` where
// v1 = HMAC-SHA256(secret, "<t>.<rawBody>"). Slice 4b's Stripe adapter swaps
// only the header name and crypto internals — the webhook route is identical.
const SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000

const EVENT_TYPES: ReadonlySet<string> = new Set([
  'funding_succeeded',
  'funding_failed',
  'funding_cleared',
  'funding_reversed',
  'refund_failed',
  'refund_settled',
] satisfies FundingEventType[])

export class MockFundingProcessor implements FundingProcessor {
  readonly provider = 'mock'
  readonly signatureHeader = 'funding-signature'

  isConfigured(): boolean {
    // THE production lock: the mock secret is never set in prod, so mock
    // funding (webhook + confirm) cannot exist there. Read at call time —
    // tests toggle it on the parsed env object.
    return Boolean(env.MOCK_FUNDING_WEBHOOK_SECRET)
  }

  async initiateFunding(): Promise<FundingInitiation> {
    // No real money exists behind the mock: initiation just mints the payment
    // ref the webhook events will echo. The dev script drives what happens next.
    return {
      provider: this.provider,
      method: 'ach',
      paymentRef: `mockpay_${crypto.randomUUID()}`,
      clientFields: {},
    }
  }

  verifySignature(rawBody: Buffer, signatureHeader: string): boolean {
    try {
      const secret = env.MOCK_FUNDING_WEBHOOK_SECRET
      if (!secret || !signatureHeader) return false

      const parts = new Map(
        signatureHeader.split(',').map((p) => {
          const eq = p.indexOf('=')
          return eq === -1 ? [p, ''] : [p.slice(0, eq), p.slice(eq + 1)]
        }),
      )
      const t = Number(parts.get('t'))
      const signature = parts.get('v1')
      if (!Number.isFinite(t) || !signature) return false
      if (Math.abs(Date.now() - t) > SIGNATURE_MAX_AGE_MS) return false

      const expected = crypto
        .createHmac('sha256', secret)
        .update(`${t}.${rawBody.toString('utf8')}`)
        .digest()
      const provided = Buffer.from(signature, 'hex')
      return provided.length === expected.length && crypto.timingSafeEqual(provided, expected)
    } catch {
      return false
    }
  }

  async voidFunding(): Promise<FundingUndo> {
    // No real money exists behind the mock: the void just mints a ref the
    // cancel path records. The key is deliberately ignored — a fresh ref each
    // call — so the exactly-once guarantee is proven to live in the caller's
    // refund_payment_ref null-gate (and, in slice 7, real Stripe's key), not in
    // the processor. Always 'succeeded' → PR1's cancel runs synchronously.
    // Always 'voided': the mock has no settlement, so the nominal mode stands
    // (undoModeForRef reads the same answer back off the mockvoid_ prefix).
    return {
      provider: this.provider,
      ref: `mockvoid_${crypto.randomUUID()}`,
      status: 'succeeded',
      mode: 'voided',
    }
  }

  async refund(): Promise<FundingUndo> {
    // Same shape as voidFunding for the PR2 PAYOUT_FAILED→REFUNDED tail; the
    // mock returns collected funds instantly and ignores amount + key. Always
    // 'refunded' — which keeps the mock-era ledger exactly as it was before
    // modes existed (refundedLedgerEntries / correctionRefundLedgerEntries).
    return {
      provider: this.provider,
      ref: `mockrefund_${crypto.randomUUID()}`,
      status: 'succeeded',
      mode: 'refunded',
    }
  }

  parseEvent(rawBody: Buffer): FundingParseResult {
    try {
      const payload = JSON.parse(rawBody.toString('utf8')) as {
        id?: string
        type?: string
        data?: { transfer_id?: string; payment_ref?: string; undo_ref?: string; reason?: string }
      }
      if (!payload.id || !payload.type) return { outcome: 'malformed' }
      if (!EVENT_TYPES.has(payload.type)) {
        // Signed but outside the mapping — same ack contract as Stripe's
        // unmapped event types; the route's warn log surfaces a script typo.
        return { outcome: 'unhandled', eventId: payload.id, eventType: payload.type }
      }
      if (!payload.data?.transfer_id || !payload.data.payment_ref) return { outcome: 'malformed' }
      return {
        outcome: 'event',
        event: {
          eventId: payload.id,
          type: payload.type as FundingEventType,
          transferRef: payload.data.transfer_id,
          paymentRef: payload.data.payment_ref,
          // The refund-tail drill leg (fire-funding-webhook refund-failed):
          // mirrors Stripe's Refund id so the page names the disbursement.
          ...(payload.data.undo_ref !== undefined && { undoRef: payload.data.undo_ref }),
          ...(payload.data.reason !== undefined && { reason: payload.data.reason }),
        },
      }
    } catch {
      return { outcome: 'malformed' }
    }
  }
}
