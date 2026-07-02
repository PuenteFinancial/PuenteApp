import type { FastifyInstance } from 'fastify'
import { supabaseAdmin } from '../../services/supabase.js'

interface WaitlistBody {
  first_name: string
  phone: string
  email?: string
  monthly_send_amount?: string
  destination_country?: string
  remittance_provider?: string
  remit_frequency?: string
  remit_years?: string
  knows_credit_score?: string
  credit_score_range?: string
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
          required: ['first_name', 'phone'],
          properties: {
            first_name: { type: 'string', minLength: 1 },
            phone: { type: 'string', minLength: 1 },
            email: { type: 'string' },
            monthly_send_amount: { type: 'string' },
            destination_country: { type: 'string' },
            remittance_provider: { type: 'string' },
            remit_frequency: { type: 'string' },
            remit_years: { type: 'string' },
            knows_credit_score: { type: 'string' },
            credit_score_range: { type: 'string' },
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
        },
      },
    },
    async (request, reply) => {
      const {
        first_name,
        phone,
        email,
        monthly_send_amount,
        destination_country,
        remittance_provider,
        remit_frequency,
        remit_years,
        knows_credit_score,
        credit_score_range,
        language_preference,
        utm_source,
        utm_medium,
        utm_campaign,
        user_agent,
      } = request.body

      const { error } = await supabaseAdmin.from('waitlist').insert({
        first_name: first_name.trim(),
        phone: phone.trim(),
        email: email?.trim() || null,
        monthly_send_amount: monthly_send_amount || null,
        destination_country: destination_country || null,
        remittance_provider: remittance_provider || null,
        remit_frequency: remit_frequency || null,
        remit_years: remit_years || null,
        knows_credit_score: knows_credit_score || null,
        credit_score_range: credit_score_range || null,
        language_preference: language_preference || 'en',
        utm_source: utm_source || null,
        utm_medium: utm_medium || null,
        utm_campaign: utm_campaign || null,
        user_agent: user_agent || null,
      })

      if (error) {
        server.log.error({ supabaseError: error.message }, 'waitlist insert failed')
        return reply.status(500).send({ error: 'Failed to join waitlist' })
      }

      return { success: true }
    },
  )
}
