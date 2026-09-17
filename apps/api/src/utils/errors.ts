import type { FastifyReply } from 'fastify'

// Stable machine-readable codes per docs/api-contract.md "Error taxonomy".
// Clients branch on `code`; `message` is human display only and may change.
export type ApiErrorCode =
  | 'validation_error'
  | 'unauthorized'
  | 'forbidden'
  | 'kyc_required'
  | 'limit_exceeded'
  // The mirror of limit_exceeded at the other end: too SMALL for the
  // destination rail to pay out (PAYOUT_MIN_RECEIVE_MINOR; MXN/SPEI is 50 MXN).
  // Its own code because the sender's remedy is the opposite one — send more,
  // not less — and a client that showed "limit exceeded" here would be telling
  // them to do exactly the wrong thing.
  | 'below_payout_minimum'
  | 'transfer_in_progress'
  | 'not_found'
  | 'conflict'
  | 'idempotency_conflict'
  | 'quote_expired'
  | 'transfer_not_cancelable'
  // 409 on the PRE-PAYMENT cancel only: the funding object could not be closed
  // because it is no longer open at the processor. Deliberately its own code
  // rather than `transfer_not_cancelable`, which means "this transfer is past
  // the point of cancelling" — this means the opposite, that the answer is not
  // settled yet and a moment's wait resolves it. Also deliberately NOT named
  // near `transfer_in_progress` above: that one is the uncleared-exposure cap
  // refusing a NEW send, and the two would be read for each other in a log.
  //
  // NARROWED 2026-09-16: this is now the PAYING shape only — the sender paid in
  // the race window and a funding webhook is coming. It used to cover an
  // already-dead object too, because the processor seam reported both as one
  // `not_open`; that told the sender their payment might have gone through when
  // nothing could ever pay it, and left them with a 409 that would never
  // change. A dead object now answers `already_closed` and the cancel simply
  // succeeds. The copy still asserts nothing beyond "check back", which is the
  // honest thing to say about a payment genuinely in flight.
  | 'funding_in_progress'
  // Dual use, and deliberately one code: as the 202 body's `code` when a
  // post-submission cancel is RECORDED for out-of-band handling, and as a 409
  // when a pre-payment cancel refuses (an out-of-band payment was claimed, or
  // the rail cannot close its own funding object). Both say the same thing to
  // the sender — a human has to take it from here — and the web already maps
  // this string to that copy. The status distinguishes them for the client;
  // `classifyCancelResponse` branches on status before code.
  | 'cancellation_requires_support'
  // The sender freeze (loss path, 2026-09-10), 403: a chargeback or ACH return
  // withdrew this account's privilege to transact. Its own code rather than a
  // bare `forbidden` because the client owes the sender an accurate reason —
  // "you don't have access" describes a permission bug, not a frozen account —
  // and because support triage starts from this code.
  | 'account_suspended'
  // Ops resolve-cancellation refusals (slice 8.5-v1.1) — all 409, but each
  // demands DIFFERENT operator behavior, so each gets its own code:
  // refund_owed = permanent legal refusal (both §1005.34 conditions held — no
  // tool may deny this request); claim_abandoned = danger state, go to
  // runbooks/manual-refund.md, never retry; deposit_evidence_conflict = the
  // cited timestamp is provably wrong, details[] carries the legal bounds.
  | 'refund_owed'
  | 'claim_abandoned'
  | 'deposit_evidence_conflict'
  // Ops refund (ops board slice 1 / O-B), 409: the principal-returned
  // interlock failed — the recorded payment_events return row and Bridge's
  // live state must AGREE before a refund may post, and one of them said no
  // (no event recorded, or Bridge disagrees — including refund_failed, where
  // the principal is stuck AT Bridge). Never retry from the UI: the operator
  // reads the Bridge dashboard and follows runbooks/manual-refund.md.
  | 'principal_not_returned'
  // Ops hold-release (2026-09-14), 409: the hold is one an operator MAY release
  // and the row has not moved — but releasing it cannot clear it, because the
  // condition that placed it is one the submit job re-measures identically on
  // the next sweep (a `fx_drift` hold whose quote is past
  // FX_MAX_QUOTE_AGE_MINUTES: quote age only grows). Its own code because the
  // operator reaction is the opposite of `conflict`: not "refresh and look
  // again" but "release is not the exit for this row — cancel and refund it".
  | 'hold_cannot_clear'
  // Onramp supportability refusal (#213): the funding processor can't serve
  // this sender's location/profile. 403 at confirm; permanent for the sender
  // from this network location, not retryable-later like not_configured.
  | 'funding_unsupported'
  // Embedded onramp (K5): the user must (re)authenticate with Link before
  // this call can work — no stored OAuth token, or no crypto customer yet.
  // Distinct from the generic 409 'conflict' because the client reaction
  // differs (restart Link auth vs. recollect payment), and clients may only
  // branch on codes, never messages.
  | 'link_auth_required'
  // K6 relay (409): Bridge already holds a customer with this identity (tax
  // id or email) that is not this user's. Terminal for self-serve — support
  // route only, never auto-link (decision 9). Distinct from the generic
  // 'conflict' because the client shows a dead end, not a retry.
  | 'duplicate_identity'
  | 'rate_limited'
  | 'rate_unavailable'
  | 'provider_rejected'
  | 'provider_unavailable'
  | 'not_configured'
  | 'internal_error'

export interface ApiErrorDetail {
  path: string
  issue: string
}

// Shared response schema for every error status — doubles as the output
// allowlist (Fastify strips anything not listed).
export const errorResponseSchema = {
  type: 'object',
  properties: {
    error: {
      type: 'object',
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        requestId: { type: 'string' },
        details: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              issue: { type: 'string' },
            },
          },
        },
      },
    },
  },
} as const

export function sendError(
  reply: FastifyReply,
  status: number,
  code: ApiErrorCode,
  message: string,
  details?: ApiErrorDetail[],
) {
  return reply.status(status).send({
    error: {
      code,
      message,
      requestId: reply.request.id,
      ...(details && { details }),
    },
  })
}
