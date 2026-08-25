import type { FastifyReply } from 'fastify'

// Stable machine-readable codes per docs/api-contract.md "Error taxonomy".
// Clients branch on `code`; `message` is human display only and may change.
export type ApiErrorCode =
  | 'validation_error'
  | 'unauthorized'
  | 'forbidden'
  | 'kyc_required'
  | 'limit_exceeded'
  | 'transfer_in_progress'
  | 'not_found'
  | 'conflict'
  | 'idempotency_conflict'
  | 'quote_expired'
  | 'transfer_not_cancelable'
  // Ops resolve-cancellation refusals (slice 8.5-v1.1) — all 409, but each
  // demands DIFFERENT operator behavior, so each gets its own code:
  // refund_owed = permanent legal refusal (both §1005.34 conditions held — no
  // tool may deny this request); claim_abandoned = danger state, go to
  // runbooks/manual-refund.md, never retry; deposit_evidence_conflict = the
  // cited timestamp is provably wrong, details[] carries the legal bounds.
  | 'refund_owed'
  | 'claim_abandoned'
  | 'deposit_evidence_conflict'
  // Onramp supportability refusal (#213): the funding processor can't serve
  // this sender's location/profile. 403 at confirm; permanent for the sender
  // from this network location, not retryable-later like not_configured.
  | 'funding_unsupported'
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
