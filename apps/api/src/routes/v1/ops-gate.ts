import type { FastifyReply, FastifyRequest, onRequestAsyncHookHandler } from 'fastify'
import { env } from '../../config/env.js'
import { sendError } from '../../utils/errors.js'

// The ops surface's access gate, in one place (ops board slice 1). Before this
// module every ops route carried its own copy of the same five lines; a gate
// that exists in six places is a gate that drifts.
//
// Posture (decisions.md 2026-08-01, 8.5-v1 + v1.1):
//   read  — identity: the caller's user id is in OPS_ADMIN_USER_IDS.
//   write — identity × capability: the allowlist AND OPS_WRITE_ENABLED, both
//           positively set in Doppler. Either alone is nothing.
//   Non-members get a 404 whose body is byte-identical to the router's own
//   not-found response ('Route not found'): this surface must not confirm it
//   exists. Never 403.
//
// Two hooks + two predicates because the gate must run TWICE per request:
//   1. as a route-level onRequest hook, BEFORE schema validation and the
//      idempotency preHandler — otherwise a non-admin probing with a garbage
//      body (or no Idempotency-Key) would get a 400 and learn the route exists.
//      Runs after the global auth hook, so request.user is set.
//   2. as the handler's FIRST statement — env can drift after registration.
// Registration itself is the outer control (server.ts registers the ops
// plugins only when the allowlist is non-empty; write routes only when
// opsWriteEnabled()).

// Both controls positively set, or the write surface does not exist. Mirrors
// devEndpointsEnabled(). Exported for tests and every ops write route.
export function opsWriteEnabled(): boolean {
  return env.OPS_WRITE_ENABLED && env.OPS_ADMIN_USER_IDS.size > 0
}

export function opsReadAllowed(request: FastifyRequest): boolean {
  const userId = request.user?.id
  return userId != null && env.OPS_ADMIN_USER_IDS.has(userId)
}

export function opsWriteAllowed(request: FastifyRequest): boolean {
  return opsWriteEnabled() && opsReadAllowed(request)
}

// The one not-found body every ops refusal-to-exist uses. Same code, same
// message as plugins/error-handler's router fallback — ops.test.ts asserts the
// two are indistinguishable.
export function denyAsNotFound(reply: FastifyReply) {
  return sendError(reply, 404, 'not_found', 'Route not found')
}

export const opsReadOnRequest: onRequestAsyncHookHandler = async (request, reply) => {
  if (!opsReadAllowed(request)) return denyAsNotFound(reply)
}

export const opsWriteOnRequest: onRequestAsyncHookHandler = async (request, reply) => {
  if (!opsWriteAllowed(request)) return denyAsNotFound(reply)
}
