import type { FastifyInstance, FastifyReply } from 'fastify'
import { supabaseAdmin } from '../../services/supabase.js'

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

const errorResponseSchema = {
  type: 'object',
  properties: { error: { type: 'string' } },
} as const

// The whole /v1/recipients surface is post-KYC: recipient rows are PII we
// only hold for onboarded senders. Returns the user's bridge_customer_id
// for the destination-create path; replies 403 and returns null otherwise.
export async function requireApprovedUser(
  userId: string,
  reply: FastifyReply,
): Promise<{ bridgeCustomerId: string | null } | null> {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('kyc_status, bridge_customer_id')
    .eq('id', userId)
    .single()

  if (error || !data) {
    await reply.status(404).send({ error: 'User not found' })
    return null
  }
  const user = data as { kyc_status: string; bridge_customer_id: string | null }
  if (user.kyc_status !== 'approved') {
    await reply
      .status(403)
      .send({ error: 'Complete identity verification first' })
    return null
  }
  return { bridgeCustomerId: user.bridge_customer_id }
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
      if (!(await requireApprovedUser(userId, reply))) return

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
        return reply.status(500).send({ error: 'Failed to save recipient' })
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
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id
      const { limit } = request.query

      // Validate the cursor before touching the DB.
      let cursor: Cursor | null = null
      if (request.query.cursor) {
        cursor = decodeCursor(request.query.cursor)
        if (!cursor) {
          return reply.status(400).send({ error: 'Invalid cursor' })
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
        return reply.status(500).send({ error: 'Failed to load recipients' })
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
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id
      const { data, error } = await supabaseAdmin
        .from('recipients')
        .select(RECIPIENT_COLUMNS)
        .eq('id', request.params.id)
        .eq('user_id', userId)
        .single()

      // Scoped by user_id: a foreign id 404s identically to a missing one,
      // never confirming another owner's row exists.
      if (error || !data) {
        return reply.status(404).send({ error: 'Recipient not found' })
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
        return reply.status(400).send({ error: 'No updatable fields provided' })
      }

      if (!(await requireApprovedUser(userId, reply))) return

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
          return reply.status(404).send({ error: 'Recipient not found' })
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
          return reply.status(500).send({ error: 'Failed to update recipient' })
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
        return reply.status(404).send({ error: 'Recipient not found' })
      }
      return toApiRecipient(data as RecipientRow)
    },
  )
}
