import type { FastifyInstance, FastifyReply } from 'fastify'
import { supabaseAdmin } from '../../services/supabase.js'
import { currentIdentityFlow } from '../../services/funding/index.js'
import { fetchGrantedConsents, missingConsents } from './consents.js'
import { sendError, errorResponseSchema } from '../../utils/errors.js'

export const RECIPIENT_COLUMNS =
  'id, first_name, last_name, relationship, country, status, created_at, updated_at'

export interface RecipientRow {
  id: string
  first_name: string
  last_name: string
  relationship: string
  country: string
  status: string
  created_at: string
  updated_at: string
}

export function toApiRecipient(row: RecipientRow) {
  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    relationship: row.relationship,
    country: row.country,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export const recipientResponseSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    firstName: { type: 'string' },
    lastName: { type: 'string' },
    relationship: { type: 'string' },
    country: { type: 'string' },
    status: { type: 'string' },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
  },
} as const

// The whole /v1/recipients surface is post-onboarding: recipient rows are PII
// we only hold for onboarded senders. Returns the user's bridge_customer_id
// for the destination-create path; replies 403 and returns null otherwise.
//
// "The whole surface" now means the reads too. Until 2026-08-14 this was called
// by the write handlers only, so the sentence above described the intent while
// the list, single-read and destination-list handlers returned 200 to any
// authenticated user — recipient names, relationships and CLABE last-4 readable
// before identity verification. Found by porting the screen to mobile and
// measuring the gate rather than trusting this comment. Every handler on this
// surface calls it now; a new one that does not is the bug.
//
// WHAT "onboarded" means depends on the funding rail (K4, KYC rehaul):
//   legacy rails — kyc_status = 'approved' (Bridge/Persona verified during
//     onboarding; the pre-rehaul front door).
//   stripe_crypto (deferredInitiation) — profile complete + consents current.
//     Identity verification moved INSIDE the send flow (Stripe verifies at
//     the pay step and refuses sessions until verified), so gating this
//     surface on kyc_status would deadlock every new-flow user out of the
//     send flow that IS their KYC. Renamed from requireApprovedUser in K4.
export async function requireOnboardedUser(
  userId: string,
  reply: FastifyReply,
): Promise<{
  bridgeCustomerId: string | null
  // Name/email ride along for the onramp KYC prefill at confirm (#213) —
  // already read here, so confirm doesn't pay a second users select.
  firstName: string | null
  lastName: string | null
  email: string | null
} | null> {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select(
      'kyc_status, status, bridge_customer_id, first_name, last_name, email, address_line1, address_city, address_state, address_postal_code',
    )
    .eq('id', userId)
    .single()

  if (error || !data) {
    await sendError(reply, 404, 'not_found', 'User not found')
    return null
  }
  const user = data as {
    kyc_status: string
    status: string
    bridge_customer_id: string | null
    first_name: string | null
    last_name: string | null
    email: string | null
    address_line1: string | null
    address_city: string | null
    address_state: string | null
    address_postal_code: string | null
  }

  // THE SENDER FREEZE (the loss path, 2026-09-10). Checked before anything
  // rail-specific because it is not about identity or readiness: a chargeback
  // or ACH return withdraws the privilege of transacting, whatever the rail.
  // Placed here rather than on the transfer-create handler alone because this
  // helper already gates the ENTIRE post-onboarding surface — recipients and
  // destinations included — and a frozen sender adding a fresh recipient is
  // the first move of the fraud pattern this freeze exists to stop.
  //
  // Deliberately NOT applied to cancellation: routes/v1/transfers.ts leaves
  // cancel ungated on purpose (a legal right), and freezing must not take that
  // away from someone whose money is still in our hands.
  if (user.status === 'suspended') {
    await sendError(reply, 403, 'account_suspended', 'Account suspended')
    return null
  }

  // WHAT "ONBOARDED" MEANS DEPENDS ON THE RAIL (C4).
  //
  // Historically it meant `kyc_status = 'approved'`: identity was established
  // during onboarding, before the sender had decided to send anything, and the
  // whole K lane existed to move it OFF that path. On any rail that verifies
  // inside the pay step, demanding approval here would refuse the sender at
  // the door for not yet having done the thing the pay step is about to ask
  // them to do — so the gate is profile + consents, and identity is the pay
  // step's business.
  //
  // Keyed on `identityFlow`, NOT on `deferredInitiation` as it was before:
  // that flag means "don't create the payment object at confirm", which the
  // Checkout rail does not want (it initiates eagerly) while still doing
  // identity at the pay step. The two happened to coincide when the crypto
  // rail was the only one; they don't any more, and reading the wrong one
  // makes every fresh sender on the Checkout rail a 403 at transfer creation.
  if (currentIdentityFlow() !== 'none') {
    const profileComplete = Boolean(
      user.first_name &&
        user.last_name &&
        user.email &&
        user.address_line1 &&
        user.address_city &&
        user.address_state &&
        user.address_postal_code,
    )
    if (!profileComplete) {
      await sendError(reply, 403, 'forbidden', 'Complete your profile first')
      return null
    }
    const granted = await fetchGrantedConsents(userId)
    if (granted === null) {
      await sendError(reply, 500, 'internal_error', 'Failed to load consents')
      return null
    }
    if (missingConsents(granted).length > 0) {
      await sendError(reply, 403, 'forbidden', 'Review and accept the required agreements first')
      return null
    }
  } else if (user.kyc_status !== 'approved') {
    // 'none' rails only: nothing downstream will verify this sender, so an
    // approved status from onboarding is the only evidence there will ever be.
    await sendError(reply, 403, 'kyc_required', 'Complete identity verification first')
    return null
  }

  return {
    bridgeCustomerId: user.bridge_customer_id,
    firstName: user.first_name,
    lastName: user.last_name,
    email: user.email,
  }
}

interface CreateRecipientBody {
  firstName: string
  lastName: string
  relationship: string
  country: string
}

interface UpdateRecipientBody {
  firstName?: string
  lastName?: string
  relationship?: string
  status?: 'active' | 'archived'
}

interface ListQuery {
  limit: number
  cursor?: string
}

interface Cursor {
  c: string // created_at
  i: string // id
}

function decodeCursor(cursor: string): Cursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Cursor
    if (typeof parsed.c !== 'string' || typeof parsed.i !== 'string') return null
    // Both values are interpolated into a PostgREST filter string below —
    // reject anything that isn't a plain timestamp/uuid shape.
    if (!/^[0-9TZ:.+-]+$/.test(parsed.c) || !/^[0-9a-f-]{36}$/.test(parsed.i)) return null
    return parsed
  } catch {
    return null
  }
}

function encodeCursor(row: RecipientRow): string {
  return Buffer.from(JSON.stringify({ c: row.created_at, i: row.id })).toString('base64url')
}

export async function recipientsRoute(server: FastifyInstance) {
  server.post<{ Body: CreateRecipientBody }>(
    '/recipients',
    {
      schema: {
        body: {
          type: 'object',
          required: ['firstName', 'lastName', 'relationship', 'country'],
          properties: {
            firstName: { type: 'string', minLength: 1, maxLength: 100, pattern: '\\S' },
            lastName: { type: 'string', minLength: 1, maxLength: 100, pattern: '\\S' },
            relationship: { type: 'string', minLength: 1, maxLength: 100, pattern: '\\S' },
            country: { type: 'string', pattern: '^[A-Z]{2}$' },
          },
          additionalProperties: false,
        },
        response: {
          201: recipientResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id
      if (!(await requireOnboardedUser(userId, reply))) return

      const { firstName, lastName, relationship, country } = request.body
      const { data, error } = await supabaseAdmin
        .from('recipients')
        .insert({
          user_id: userId,
          first_name: firstName.trim(),
          last_name: lastName.trim(),
          relationship: relationship.trim(),
          country,
        })
        .select(RECIPIENT_COLUMNS)
        .single()

      if (error || !data) {
        server.log.error({ userId, supabaseError: error?.code }, 'recipient insert failed')
        return sendError(reply, 500, 'internal_error', 'Failed to save recipient')
      }

      return reply.status(201).send(toApiRecipient(data as RecipientRow))
    },
  )

  server.get<{ Querystring: ListQuery }>(
    '/recipients',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
            cursor: { type: 'string' },
          },
          additionalProperties: false,
        },
        response: {
          200: {
            type: 'object',
            properties: {
              data: { type: 'array', items: recipientResponseSchema },
              nextCursor: { type: ['string', 'null'] },
            },
          },
          400: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id
      if (!(await requireOnboardedUser(userId, reply))) return

      const { limit } = request.query

      // Validate the cursor before touching the DB.
      let cursor: Cursor | null = null
      if (request.query.cursor) {
        cursor = decodeCursor(request.query.cursor)
        if (!cursor) {
          return sendError(reply, 400, 'validation_error', 'Invalid cursor')
        }
      }

      let query = supabaseAdmin
        .from('recipients')
        .select(RECIPIENT_COLUMNS)
        .eq('user_id', userId)
        .eq('status', 'active')
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(limit + 1)

      if (cursor) {
        query = query.or(
          `created_at.lt.${cursor.c},and(created_at.eq.${cursor.c},id.lt.${cursor.i})`,
        )
      }

      const { data, error } = await query
      if (error || !data) {
        server.log.error({ userId, supabaseError: error?.code }, 'recipient list failed')
        return sendError(reply, 500, 'internal_error', 'Failed to load recipients')
      }

      const rows = data as RecipientRow[]
      const page = rows.slice(0, limit)
      const nextCursor = rows.length > limit ? encodeCursor(page[page.length - 1]!) : null
      return { data: page.map(toApiRecipient), nextCursor }
    },
  )

  server.get<{ Params: { id: string } }>(
    '/recipients/:id',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        response: {
          200: recipientResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id
      if (!(await requireOnboardedUser(userId, reply))) return

      const { data, error } = await supabaseAdmin
        .from('recipients')
        .select(RECIPIENT_COLUMNS)
        .eq('id', request.params.id)
        .eq('user_id', userId)
        .single()

      // Scoped by user_id: a foreign id 404s identically to a missing one,
      // never confirming another owner's row exists.
      if (error || !data) {
        return sendError(reply, 404, 'not_found', 'Recipient not found')
      }
      return toApiRecipient(data as RecipientRow)
    },
  )

  server.patch<{ Params: { id: string }; Body: UpdateRecipientBody }>(
    '/recipients/:id',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          minProperties: 1,
          properties: {
            firstName: { type: 'string', minLength: 1, maxLength: 100, pattern: '\\S' },
            lastName: { type: 'string', minLength: 1, maxLength: 100, pattern: '\\S' },
            relationship: { type: 'string', minLength: 1, maxLength: 100, pattern: '\\S' },
            // country is immutable: destinations were validated against it
            status: { type: 'string', enum: ['active', 'archived'] },
          },
          additionalProperties: false,
        },
        response: {
          200: recipientResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id
      const { firstName, lastName, relationship, status } = request.body

      // Fastify's default removeAdditional strips unknown properties AFTER
      // minProperties passes, so a body of only stripped fields (e.g.
      // { country }) arrives here empty — reject it before any DB work.
      if (
        firstName === undefined &&
        lastName === undefined &&
        relationship === undefined &&
        status === undefined
      ) {
        return sendError(reply, 400, 'validation_error', 'No updatable fields provided')
      }

      if (!(await requireOnboardedUser(userId, reply))) return

      // Archiving cascades to the recipient's destinations FIRST, so a crash
      // between the two updates can never leave payable destinations under an
      // archived recipient. Un-archiving is deliberately asymmetric:
      // destinations stay archived until re-added.
      if (status === 'archived') {
        const { data: owned } = await supabaseAdmin
          .from('recipients')
          .select('id')
          .eq('id', request.params.id)
          .eq('user_id', userId)
          .single()
        if (!owned) {
          return sendError(reply, 404, 'not_found', 'Recipient not found')
        }
        const { error: cascadeError } = await supabaseAdmin
          .from('payout_destinations')
          .update({ status: 'archived' })
          .eq('recipient_id', request.params.id)
          .eq('status', 'active')
        if (cascadeError) {
          server.log.error(
            { userId, supabaseError: cascadeError.code },
            'destination cascade-archive failed',
          )
          return sendError(reply, 500, 'internal_error', 'Failed to update recipient')
        }
      }

      const { data, error } = await supabaseAdmin
        .from('recipients')
        .update({
          ...(firstName !== undefined && { first_name: firstName.trim() }),
          ...(lastName !== undefined && { last_name: lastName.trim() }),
          ...(relationship !== undefined && { relationship: relationship.trim() }),
          ...(status !== undefined && { status }),
        })
        .eq('id', request.params.id)
        .eq('user_id', userId)
        .select(RECIPIENT_COLUMNS)
        .single()

      if (error || !data) {
        return sendError(reply, 404, 'not_found', 'Recipient not found')
      }
      return toApiRecipient(data as RecipientRow)
    },
  )
}
