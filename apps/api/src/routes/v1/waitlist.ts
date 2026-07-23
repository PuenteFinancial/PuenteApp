import type { FastifyInstance } from 'fastify'
import { supabaseAdmin } from '../../services/supabase.js'
import { sendError, errorResponseSchema } from '../../utils/errors.js'

interface WaitlistBody {
  first_name: string
  phone: string
  destination_country: string
  referral_source: string
  referral_source_other?: string
  language_preference?: string
  utm_source?: string
  utm_medium?: string
  utm_campaign?: string
  user_agent?: string
}

export async function waitlistRoute(server: FastifyInstance) {
  server.post<{ Body: WaitlistBody }>(
    '/waitlist',
    {
      config: { public: true },
      schema: {
        body: {
          type: 'object',
          required: ['first_name', 'phone', 'destination_country', 'referral_source'],
          properties: {
            first_name: { type: 'string', minLength: 1 },
            phone: { type: 'string', minLength: 1 },
            destination_country: { type: 'string', minLength: 1 },
            referral_source: { type: 'string', minLength: 1 },
            referral_source_other: { type: 'string' },
            language_preference: { type: 'string' },
            utm_source: { type: 'string' },
            utm_medium: { type: 'string' },
            utm_campaign: { type: 'string' },
            user_agent: { type: 'string' },
          },
          additionalProperties: false,
        },
        response: {
          200: {
            type: 'object',
            properties: { success: { type: 'boolean' } },
          },
          400: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const {
        first_name,
        phone,
        destination_country,
        referral_source,
        referral_source_other,
        language_preference,
        utm_source,
        utm_medium,
        utm_campaign,
        user_agent,
      } = request.body

      if (referral_source === 'Other' && !referral_source_other?.trim()) {
        return sendError(reply, 400, 'validation_error', 'referral_source_other is required when referral_source is "Other"')
      }

      const { error } = await supabaseAdmin.from('waitlist').insert({
        first_name: first_name.trim(),
        phone: phone.trim(),
        destination_country: destination_country.trim(),
        referral_source,
        referral_source_other: referral_source === 'Other' ? referral_source_other?.trim() || null : null,
        language_preference: language_preference || 'en',
        utm_source: utm_source || null,
        utm_medium: utm_medium || null,
        utm_campaign: utm_campaign || null,
        user_agent: user_agent || null,
      })

      if (error) {
        server.log.error({ supabaseError: error.message }, 'waitlist insert failed')
        return sendError(reply, 500, 'internal_error', 'Failed to join waitlist')
      }

      return { success: true }
    },
  )
}
