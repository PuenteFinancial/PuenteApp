import { describe, it, expect } from 'vitest'
import { refundResponseSchema } from './ops-transfers.js'
import { resolveResponseSchema } from './ops.js'
import type { RefundOutcome } from '../../services/refunds.js'
import type { ReviewOutcome } from '../../services/cancellation-review.js'

// THE WIRE HALF OF AN OUTCOME UNION.
//
// A service returns a discriminated union; a route serialises it through a
// response schema whose `outcome` is an enum of string literals. TypeScript
// cannot connect those two — the schema is a runtime object, and the string
// literals in it have no relationship to the union — so an arm can be added to
// one and not the other, and nothing anywhere says so.
//
// WHAT THAT COSTS, MEASURED RATHER THAN ASSUMED (2026-09-16). An earlier
// version of this comment said an unlisted outcome would be REJECTED at
// response time inside fast-json-stringify. It is not. Narrowing
// `refundResponseSchema.outcome`'s enum to a value the service can never
// produce changes nothing: every outcome still serialises and all 66 route
// tests pass. fast-json-stringify 7.0.1 — what fastify 5.12.4 resolves here —
// uses `enum` to choose a fast path, not to constrain. Unlisted PROPERTIES are
// genuinely dropped (see ops-transfers.test.ts, both directions); unlisted enum
// VALUES are not.
//
// So the failure this prevents is documentary, not a 500: the response schema
// is the published contract for a money route, and one that omits an outcome
// the service returns is a false statement about the API to everyone who reads
// it to learn what the route can say. It also stops being merely documentary
// the moment Fastify response VALIDATION is switched on, or fast-json-stringify
// starts enforcing what it advertises — neither of which would announce itself.
// Keeping the two exactly equal is a few lines; finding out the other way is
// not.
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
