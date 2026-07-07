import type { FastifyInstance } from 'fastify'
import { env } from '../../config/env.js'
import { supabaseAdmin } from '../../services/supabase.js'
import { createBridgeCustomer, getKycLink, BridgeApiError } from '../../services/bridge.js'

const USER_COLUMNS = 'id, first_name, last_name, email, kyc_status, bridge_customer_id'

interface UserRow {
  id: string
  first_name: string | null
  last_name: string | null
  email: string | null
  kyc_status: string
  bridge_customer_id: string | null
}

function toApiUser(row: UserRow) {
  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    kycStatus: row.kyc_status,
    bridgeCustomerId: row.bridge_customer_id,
  }
}

const userResponseSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    firstName: { type: ['string', 'null'] },
    lastName: { type: ['string', 'null'] },
    email: { type: ['string', 'null'] },
    kycStatus: { type: 'string' },
    bridgeCustomerId: { type: ['string', 'null'] },
  },
} as const

interface UpdateMeBody {
  firstName: string
  lastName: string
  email: string
}

interface KycLinkBody {
  signed_agreement_id: string
}

export async function usersRoute(server: FastifyInstance) {
  server.get(
    '/users/me',
    {
      schema: {
        response: {
          200: userResponseSchema,
          404: {
            type: 'object',
            properties: { error: { type: 'string' } },
          },
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id
      const { data, error } = await supabaseAdmin
        .from('users')
        .select(USER_COLUMNS)
        .eq('id', userId)
        .single()

      if (error || !data) {
        return reply.status(404).send({ error: 'User not found' })
      }

      return toApiUser(data as UserRow)
    },
  )

  server.patch<{ Body: UpdateMeBody }>(
    '/users/me',
    {
      schema: {
        body: {
          type: 'object',
          required: ['firstName', 'lastName', 'email'],
          properties: {
            firstName: { type: 'string', minLength: 1, maxLength: 100 },
            lastName: { type: 'string', minLength: 1, maxLength: 100 },
            email: { type: 'string', format: 'email' },
          },
          additionalProperties: false,
        },
        response: { 200: userResponseSchema },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id
      const { firstName, lastName, email } = request.body

      const { data, error } = await supabaseAdmin
        .from('users')
        .update({
          first_name: firstName.trim(),
          last_name: lastName.trim(),
          email: email.trim(),
        })
        .eq('id', userId)
        .select(USER_COLUMNS)
        .single()

      if (error || !data) {
        server.log.error({ userId, supabaseError: error?.code }, 'profile update failed')
        return reply.status(500).send({ error: 'Failed to update profile' })
      }

      // Triggers Supabase's email verification flow. Non-blocking by design:
      // the user may continue onboarding before confirming their email.
      supabaseAdmin.auth.admin
        .updateUserById(userId, { email: email.trim() })
        .then(({ error: emailError }) => {
          if (emailError) {
            server.log.warn({ userId, authError: emailError.status }, 'email verification trigger failed')
          }
        })
        .catch(() => {
          server.log.warn({ userId }, 'email verification trigger failed')
        })

      return toApiUser(data as UserRow)
    },
  )

  server.post<{ Body: KycLinkBody }>(
    '/users/me/kyc-link',
    {
      schema: {
        body: {
          type: 'object',
          required: ['signed_agreement_id'],
          properties: {
            signed_agreement_id: { type: 'string', minLength: 1 },
          },
          additionalProperties: false,
        },
        response: {
          200: {
            type: 'object',
            properties: { url: { type: 'string' } },
          },
        },
      },
    },
    async (request, reply) => {
      const userId = request.user!.id

      const { data, error } = await supabaseAdmin
        .from('users')
        .select(USER_COLUMNS)
        .eq('id', userId)
        .single()

      if (error || !data) {
        return reply.status(404).send({ error: 'User not found' })
      }

      const user = data as UserRow
      if (!user.first_name || !user.last_name || !user.email) {
        return reply.status(400).send({ error: 'Complete your profile before identity verification' })
      }

      try {
        let bridgeCustomerId = user.bridge_customer_id

        if (!bridgeCustomerId) {
          const created = await createBridgeCustomer({
            firstName: user.first_name,
            lastName: user.last_name,
            email: user.email,
            signedAgreementId: request.body.signed_agreement_id,
          })
          bridgeCustomerId = created.id

          const { error: saveError } = await supabaseAdmin
            .from('users')
            .update({ bridge_customer_id: bridgeCustomerId })
            .eq('id', userId)

          if (saveError) {
            server.log.error({ userId, supabaseError: saveError.code }, 'bridge customer save failed')
            return reply.status(500).send({ error: 'Failed to start identity verification' })
          }
        }

        const { url } = await getKycLink(
          bridgeCustomerId,
          `${env.ALLOWED_ORIGINS[0]}/onboarding/kyc/return`,
        )
        return { url }
      } catch (err) {
        if (err instanceof BridgeApiError) {
          server.log.error({ userId, bridgeStatus: err.status }, 'bridge request failed')
          return reply.status(502).send({ error: 'Identity verification is unavailable, try again shortly' })
        }
        throw err
      }
    },
  )
}
