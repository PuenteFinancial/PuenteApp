import { describe, it, expect } from 'vitest'
import { refundResponseSchema } from './ops-transfers.js'
import { resolveResponseSchema } from './ops.js'
import type { RefundOutcome } from '../../services/refunds.js'
import type { ReviewOutcome } from '../../services/cancellation-review.js'

// THE WIRE HALF OF AN OUTCOME UNION.
//
// A service returns a discriminated union; a route serialises it through a
// response schema whose `outcome` is an enum of string literals. TypeScript
// cannot connect those two — the schema is a runtime object, and `as const`
// string literals in it have no relationship to the union — so adding an arm
// compiles cleanly and then fails at RESPONSE time, inside fast-json-stringify,
// on a money route. That is the worst possible place to find out.
//
// This is the same shape as the gap that let `holdRelease` be tested on the
// service side and on the client side with nothing checking the wire between
// them. Found here the honest way: adding `awaiting_disbursement` in the B6
// commit passed typecheck and the whole suite, and BOTH enums would have
// rejected it in production.
//
// The mechanism is the Record below, not the assertion. `Record<Union, true>`
// demands every member as a key and excess-property checking rejects anything
// extra, so the object is a compile-time proof that the list is exactly the
// union — no more, no less. Add an arm and the BUILD breaks here; the test then
// tells you which schema has not caught up.

const REFUND_DONE_OUTCOMES: Record<Extract<RefundOutcome, { done: true }>['outcome'], true> = {
  refunded: true,
  already_disbursed: true,
  already_settled: true,
  awaiting_disbursement: true,
}

const REVIEW_DONE_OUTCOMES: Record<Extract<ReviewOutcome, { done: true }>['outcome'], true> = {
  refunded: true,
  already_disbursed: true,
  already_refunded: true,
  denied: true,
  awaiting_disbursement: true,
}

describe('outcome unions and the wire schemas that serialise them', () => {
  it('POST /ops/transfers/refund can serialise every RefundOutcome success', () => {
    expect([...refundResponseSchema.properties.outcome.enum].sort()).toEqual(
      Object.keys(REFUND_DONE_OUTCOMES).sort(),
    )
  })

  it('POST /ops/cancellations/resolve can serialise every ReviewOutcome success', () => {
    expect([...resolveResponseSchema.properties.outcome.enum].sort()).toEqual(
      Object.keys(REVIEW_DONE_OUTCOMES).sort(),
    )
  })

  // Equality, not containment, on purpose. A schema listing an outcome the
  // service can no longer produce is a smaller problem than the reverse, but it
  // is still a claim about the API that stopped being true — and the next person
  // reading the schema to learn the contract would believe it.
  it('neither schema advertises an outcome the service cannot produce', () => {
    const refundExtra = refundResponseSchema.properties.outcome.enum.filter(
      (value) => !(value in REFUND_DONE_OUTCOMES),
    )
    const reviewExtra = resolveResponseSchema.properties.outcome.enum.filter(
      (value) => !(value in REVIEW_DONE_OUTCOMES),
    )
    expect({ refundExtra, reviewExtra }).toEqual({ refundExtra: [], reviewExtra: [] })
  })
})
