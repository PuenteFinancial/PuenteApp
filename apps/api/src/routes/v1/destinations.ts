import type { FastifyInstance } from 'fastify'
import { supabaseAdmin } from '../../services/supabase.js'
import { createExternalAccount, listExternalAccounts, BridgeApiError } from '../../services/bridge.js'
import { isValidClabe } from '../../utils/clabe.js'
import { encryptString } from '../../utils/encryption.js'
import { requireApprovedUser } from './recipients.js'

const DESTINATION_COLUMNS =
  'id, recipient_id, method, currency, details, label, status, verification_status, created_at, updated_at'

interface DestinationRow {
  id: string
  recipient_id: string
  method: string
  currency: string
  details: { clabe_ciphertext?: string; clabe_last4?: string }
  label: string | null
  status: string
  verification_status: string
  created_at: string
  updated_at: string
}

// Builds the masked wire shape field-by-field — NEVER spreads row.details,
// so the ciphertext structurally cannot reach a response. The response
// schema below is the second layer: Fastify serialization strips anything
// not whitelisted.
function toApiDestination(row: DestinationRow) {
  return {
    id: row.id,
    recipientId: row.recipient_id,
    method: row.method,
    currency: row.currency,
    details: { clabeLast4: row.details.clabe_last4 },
    label: row.label,
    status: row.status,
    verificationStatus: row.verification_status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const destinationResponseSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    recipientId: { type: 'string' },
    method: { type: 'string' },
    currency: { type: 'string' },
    details: {
      type: 'object',
      properties: { clabeLast4: { type: 'string' } },
      additionalProperties: false,
    },
    label: { type: ['string', 'null'] },
    status: { type: 'string' },
    verificationStatus: { type: 'string' },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
  },
} as const

const errorResponseSchema = {
  type: 'object',
  properties: { error: { type: 'string' } },
} as const

interface CreateDestinationBody {
  method: 'bank_account' | 'wallet' | 'cash_pickup' | 'debit_card'
  currency: string
  details: { clabe?: string }
  label?: string
}

interface UpdateDestinationBody {
  label?: string
  // one-way: see the status schema comment on the PATCH route
  status?: 'archived'
}

interface RecipientOwnerRow {
  id: string
  first_name: string
  last_name: string
  country: string
  status: string
}

export async function destinationsRoute(server: FastifyInstance) {
  server.post<{ Params: { id: string }; Body: CreateDestinationBody }>(
    '/recipients/:id/destinations',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          required: ['method', 'currency', 'details'],
          properties: {
            method: {
              type: 'string',
              enum: ['bank_account', 'wallet', 'cash_pickup', 'debit_card'],
            },
            currency: { type: 'string', pattern: '^[A-Z]{3}$' },
            // per-(country, method) validation happens in the handler — the
            // shape differs per method, so the schema stays permissive here
            details: {
              type: 'object',
              properties: { clabe: { type: 'string' } },
              additionalProperties: false,
            },
            // pattern rejects whitespace-only values the handler would trim
            // to '' — which would otherwise fail the DB check only AFTER the
            // Bridge account is created, orphaning it
            label: { type: 'string', minLength: 1, maxLength: 100, pattern: '\\S' },
          },
          additionalProperties: false,
        },
        response: {
          201: destinationResponseSchema,
          400: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
          422: errorResponseSchema,
          502: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id

      // 1. KYC + Bridge customer gate — this is the Bridge-touching step.
      const approved = await requireApprovedUser(userId, reply)
      if (!approved) return
      if (!approved.bridgeCustomerId) {
        return reply
          .status(403)
          .send({ error: 'Complete identity verification before adding payout details' })
      }

      // 2. Owner-scoped recipient load.
      const { data: recipientData } = await supabaseAdmin
        .from('recipients')
        .select('id, first_name, last_name, country, status')
        .eq('id', request.params.id)
        .eq('user_id', userId)
        .single()

      if (!recipientData) {
        return reply.status(404).send({ error: 'Recipient not found' })
      }
      const recipient = recipientData as RecipientOwnerRow
      if (recipient.status === 'archived') {
        return reply.status(409).send({ error: 'Recipient is archived' })
      }

      // 3. (country, method) gate — MVP supports MX bank deposits only.
      const { method, currency, label } = request.body
      if (recipient.country !== 'MX' || method !== 'bank_account' || currency !== 'MXN') {
        return reply
          .status(400)
          .send({ error: 'This payout method is not yet supported for this country' })
      }

      // 4. CLABE validation — never echo the submitted value back.
      const clabe = request.body.details.clabe
      if (!clabe || !isValidClabe(clabe)) {
        return reply.status(400).send({ error: 'Invalid CLABE — check the 18-digit number' })
      }

      // 5. Register with Bridge BEFORE persisting anything: a failure leaves
      // no row behind, and a retry is simply a resubmit.
      let bridgeAccountId: string
      try {
        const account = await createExternalAccount(approved.bridgeCustomerId, {
          firstName: recipient.first_name,
          lastName: recipient.last_name,
          clabe,
        })
        bridgeAccountId = account.id
      } catch (err) {
        if (err instanceof BridgeApiError) {
          const bridgeCode = (err.body as { code?: string } | null)?.code
          server.log.error(
            { userId, recipientId: recipient.id, bridgeStatus: err.status, bridgeCode },
            'bridge external account create failed',
          )
          // Bridge dedupes identical CLABEs per customer (sandbox-verified
          // 2026-07-16): re-adding a previously registered account — even a
          // locally archived one — 400s with this code rather than minting a
          // new id. A blind 409 here would dead-end two legitimate retries:
          // a resubmit after a lost response / failed insert (Bridge has the
          // account, we have no row), and the documented archive-then-re-add
          // reactivation flow. Adopt the existing Bridge account instead.
          if (bridgeCode === 'duplicate_external_account') {
            let accounts: Awaited<ReturnType<typeof listExternalAccounts>>
            try {
              accounts = await listExternalAccounts(approved.bridgeCustomerId)
            } catch {
              server.log.error(
                { userId, recipientId: recipient.id },
                'bridge external account list failed during adoption',
              )
              return reply
                .status(502)
                .send({ error: 'Payout provider is unavailable, try again shortly' })
            }
            // Bridge only exposes last_4, so require an unambiguous match —
            // on a collision fall back to the conservative 409
            const matches = accounts.filter((a) => a.clabeLast4 === clabe.slice(-4))
            if (matches.length !== 1) {
              return reply.status(409).send({ error: 'This account is already saved' })
            }
            const adoptedId = matches[0]!.id

            const { data: existing } = await supabaseAdmin
              .from('payout_destinations')
              .select('id, recipient_id, status')
              .eq('provider_account_ref', adoptedId)
              .maybeSingle()
            const existingRow = existing as {
              id: string
              recipient_id: string
              status: string
            } | null

            if (existingRow) {
              const revivable =
                existingRow.recipient_id === recipient.id && existingRow.status === 'archived'
              if (!revivable) {
                // genuinely saved already — either active here, or it lives
                // under a different recipient of the same user
                return reply.status(409).send({ error: 'This account is already saved' })
              }
              // archive + re-add reactivation: revive the archived row
              const { data: revived, error: reviveError } = await supabaseAdmin
                .from('payout_destinations')
                .update({ status: 'active', label: label?.trim() ?? null })
                .eq('id', existingRow.id)
                .eq('recipient_id', recipient.id)
                .select(DESTINATION_COLUMNS)
                .single()
              if (reviveError || !revived) {
                server.log.error(
                  { userId, recipientId: recipient.id, supabaseError: reviveError?.code },
                  'destination revive failed',
                )
                return reply.status(500).send({ error: 'Failed to save payout destination' })
              }
              return reply.status(201).send(toApiDestination(revived as DestinationRow))
            }

            // no local row: heal the orphan by inserting with the adopted id
            bridgeAccountId = adoptedId
          } else if (err.status < 500) {
            return reply
              .status(422)
              .send({ error: 'The bank rejected this account — verify the CLABE with your recipient' })
          } else {
            return reply
              .status(502)
              .send({ error: 'Payout provider is unavailable, try again shortly' })
          }
        } else {
          // fetch network failures (TypeError) must not surface as a raw 500
          server.log.error({ userId, recipientId: recipient.id }, 'bridge request failed')
          return reply
            .status(502)
            .send({ error: 'Payout provider is unavailable, try again shortly' })
        }
      }

      // 6. Persist. verification_status stays at its 'unverified' default —
      // a Bridge 201 means registered, not verified.
      const { data, error } = await supabaseAdmin
        .from('payout_destinations')
        .insert({
          recipient_id: recipient.id,
          method,
          currency,
          details: {
            clabe_ciphertext: encryptString(clabe, recipient.id),
            clabe_last4: clabe.slice(-4),
          },
          label: label?.trim() ?? null,
          provider_account_ref: bridgeAccountId,
        })
        .select(DESTINATION_COLUMNS)
        .single()

      if (error || !data) {
        if (error?.code === '23505') {
          return reply.status(409).send({ error: 'This account is already saved' })
        }
        // The Bridge account now has no DB row — orphaned by policy (slice 8
        // reconciliation treats unmatched externals as expected noise).
        server.log.error(
          {
            event: 'bridge_external_account_orphaned',
            userId,
            recipientId: recipient.id,
            bridgeExternalAccountId: bridgeAccountId,
            supabaseError: error?.code,
          },
          'destination insert failed after bridge registration',
        )
        return reply.status(500).send({ error: 'Failed to save payout destination' })
      }

      return reply.status(201).send(toApiDestination(data as DestinationRow))
    },
  )

  server.get<{ Params: { id: string } }>(
    '/recipients/:id/destinations',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              data: { type: 'array', items: destinationResponseSchema },
            },
          },
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id

      // Archived recipients stay readable — history, not UI actions.
      const { data: recipient } = await supabaseAdmin
        .from('recipients')
        .select('id')
        .eq('id', request.params.id)
        .eq('user_id', userId)
        .single()

      if (!recipient) {
        return reply.status(404).send({ error: 'Recipient not found' })
      }

      const { data, error } = await supabaseAdmin
        .from('payout_destinations')
        .select(DESTINATION_COLUMNS)
        .eq('recipient_id', request.params.id)
        .eq('status', 'active')
        .order('created_at', { ascending: true })

      if (error || !data) {
        server.log.error({ userId, supabaseError: error?.code }, 'destination list failed')
        return reply.status(500).send({ error: 'Failed to load payout destinations' })
      }

      return { data: (data as DestinationRow[]).map(toApiDestination) }
    },
  )

  server.patch<{ Params: { id: string }; Body: UpdateDestinationBody }>(
    '/destinations/:id',
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
            // details/CLABE are immutable: a new account = archive + re-add,
            // which re-registers with Bridge
            label: { type: 'string', minLength: 1, maxLength: 100, pattern: '\\S' },
            // one-way: un-archiving is forbidden so a destination can never
            // become payable under an archived recipient — reactivation is
            // archive + re-add, matching the recipient-archive cascade design
            status: { type: 'string', enum: ['archived'] },
          },
          additionalProperties: false,
        },
        response: {
          200: destinationResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id
      const { label, status } = request.body

      // removeAdditional strips unknown fields after minProperties passes —
      // a body of only stripped fields (e.g. { details }) arrives empty.
      if (label === undefined && status === undefined) {
        return reply.status(400).send({ error: 'No updatable fields provided' })
      }

      if (!(await requireApprovedUser(userId, reply))) return

      // Flat path — ownership traverses destination → recipient → user.
      const { data: owned } = await supabaseAdmin
        .from('payout_destinations')
        .select('id, recipient_id, recipients!inner(user_id)')
        .eq('id', request.params.id)
        .eq('recipients.user_id', userId)
        .single()

      if (!owned) {
        return reply.status(404).send({ error: 'Payout destination not found' })
      }

      // user_id lives one join away, so the write can't re-check the owner
      // directly — pinning the verified recipient_id is the closest
      // belt-and-suspenders equivalent of recipients.ts's .eq('user_id')
      const { data, error } = await supabaseAdmin
        .from('payout_destinations')
        .update({
          ...(label !== undefined && { label: label.trim() }),
          ...(status !== undefined && { status }),
        })
        .eq('id', request.params.id)
        .eq('recipient_id', (owned as { recipient_id: string }).recipient_id)
        .select(DESTINATION_COLUMNS)
        .single()

      if (error || !data) {
        server.log.error({ userId, supabaseError: error?.code }, 'destination update failed')
        return reply.status(500).send({ error: 'Failed to update payout destination' })
      }
      return toApiDestination(data as DestinationRow)
    },
  )
}
