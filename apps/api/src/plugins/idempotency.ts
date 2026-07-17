import fp from 'fastify-plugin'
import crypto from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { supabaseAdmin } from '../services/supabase.js'
import { sendError } from '../utils/errors.js'

// Client-request idempotency for money-moving POSTs (api-contract: keyed per
// endpoint + user, ~24h). Routes opt in with config: { idempotency: true }.
// Flow: claim the (user, endpoint, key) row → won: run the handler and store
// the 2xx response in onSend → lost: replay the stored response, 409 on a
// different body (idempotency_conflict), 409 while the winner is in flight.
// Failed responses are never stored: the claim is released so a retry can
// re-execute (downstream guards make re-execution safe).

const KEY_PATTERN = /^[\x21-\x7e]{1,255}$/ // visible ASCII, 1–255 chars

interface ClaimRow {
  id: string
  request_hash: string
  response_status: number | null
  response_body: unknown
  expires_at: string
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, v]) => [k, sortKeysDeep(v)]),
    )
  }
  return value
}

// Canonical body hash — key order must not defeat replay matching.
export function canonicalBodyHash(body: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(sortKeysDeep(body ?? null))).digest('hex')
}

async function tryClaim(
  userId: string,
  endpoint: string,
  key: string,
  requestHash: string,
): Promise<{ claimId: string } | { error: 'taken' } | { error: 'failed'; code?: string }> {
  const { data, error } = await supabaseAdmin
    .from('idempotency_keys')
    .insert({ key, user_id: userId, endpoint, request_hash: requestHash })
    .select('id')
    .single()
  if (data) return { claimId: (data as { id: string }).id }
  if (error?.code === '23505') return { error: 'taken' }
  return { error: 'failed', ...(error?.code && { code: error.code }) }
}

export const idempotencyPlugin = fp(async (server: FastifyInstance) => {
  server.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.routeOptions?.config?.idempotency) return

    const headerValue = request.headers['idempotency-key']
    const key = Array.isArray(headerValue) ? headerValue[0] : headerValue
    if (!key || !KEY_PATTERN.test(key)) {
      return sendError(reply, 400, 'validation_error', 'Idempotency-Key header is required')
    }

    const userId = request.user!.id
    const endpoint = `${request.method} ${request.routeOptions.url}`
    const requestHash = canonicalBodyHash(request.body)

    // one retry to reap an expired row, then give up
    for (let attempt = 0; attempt < 2; attempt++) {
      const claim = await tryClaim(userId, endpoint, key, requestHash)

      if ('claimId' in claim) {
        request.idempotencyClaimId = claim.claimId
        return
      }
      if (claim.error === 'failed') {
        server.log.error({ userId, supabaseError: claim.code }, 'idempotency claim failed')
        return sendError(reply, 500, 'internal_error', 'Failed to process request')
      }

      const { data } = await supabaseAdmin
        .from('idempotency_keys')
        .select('id, request_hash, response_status, response_body, expires_at')
        .eq('user_id', userId)
        .eq('endpoint', endpoint)
        .eq('key', key)
        .single()
      const row = data as ClaimRow | null
      if (!row) continue // winner's claim vanished (released) — retry once

      if (new Date(row.expires_at) <= new Date()) {
        await supabaseAdmin.from('idempotency_keys').delete().eq('id', row.id)
        continue
      }
      if (row.request_hash !== requestHash) {
        return sendError(
          reply,
          409,
          'idempotency_conflict',
          'Idempotency-Key was already used with a different request body',
        )
      }
      if (row.response_status !== null) {
        // replay: return the stored result verbatim
        return reply.status(row.response_status).send(row.response_body)
      }
      // in-flight twin (Stripe-style): the winner hasn't finished; retry later
      return sendError(
        reply,
        409,
        'idempotency_conflict',
        'A request with this Idempotency-Key is still in progress',
      )
    }
    return sendError(reply, 500, 'internal_error', 'Failed to process request')
  })

  server.addHook('onSend', async (request, reply, payload) => {
    const claimId = request.idempotencyClaimId
    if (!claimId) return payload

    if (reply.statusCode >= 200 && reply.statusCode < 300) {
      let body: unknown = null
      try {
        body = typeof payload === 'string' ? JSON.parse(payload) : null
      } catch {
        body = null
      }
      const { error } = await supabaseAdmin
        .from('idempotency_keys')
        .update({ response_status: reply.statusCode, response_body: body })
        .eq('id', claimId)
      if (error) {
        // the client already has its result; a lost store means a future
        // replay re-executes — safe, but loud
        server.log.error({ supabaseError: error.code }, 'idempotency response store failed')
      }
    } else {
      // never replay failures — release the key so the client can retry
      const { error } = await supabaseAdmin.from('idempotency_keys').delete().eq('id', claimId)
      if (error) {
        server.log.error({ supabaseError: error.code }, 'idempotency claim release failed')
      }
    }
    return payload
  })
})
