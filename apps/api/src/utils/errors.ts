import type { FastifyReply } from 'fastify'

// Stable machine-readable codes per docs/api-contract.md "Error taxonomy".
// Clients branch on `code`; `message` is human display only and may change.
export type ApiErrorCode =
  | 'validation_error'
  | 'unauthorized'
  | 'forbidden'
  | 'kyc_required'
  | 'limit_exceeded'
  | 'not_found'
  | 'conflict'
  | 'idempotency_conflict'
  | 'quote_expired'
  | 'transfer_not_cancelable'
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
