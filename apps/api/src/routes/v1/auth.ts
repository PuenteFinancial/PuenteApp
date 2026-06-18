import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

const SignupSchema = z.object({
  phone: z.string().min(10).max(15),
  email: z.string().email(),
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  preferredLanguage: z.enum(['en', 'es']).default('en'),
})

const OtpVerifySchema = z.object({
  phone: z.string(),
  token: z.string().length(6),
})

export async function authRoute(server: FastifyInstance) {
  // Initiate phone signup — sends OTP via Twilio
  server.post(
    '/auth/signup',
    {
      config: { public: true }, // no auth required
      schema: {
        body: {
          type: 'object',
          required: ['phone', 'email', 'firstName', 'lastName'],
          properties: {
            phone: { type: 'string' },
            email: { type: 'string' },
            firstName: { type: 'string' },
            lastName: { type: 'string' },
            preferredLanguage: { type: 'string', enum: ['en', 'es'] },
          },
        },
      },
    },
    async (request, reply) => {
      const body = SignupSchema.parse(request.body)
      // TODO: create user in Supabase, send OTP via Twilio
      server.log.info({ phone: body.phone }, 'Signup initiated')
      return reply.code(201).send({ message: 'OTP sent' })
    },
  )

  // Verify OTP and return JWT
  server.post(
    '/auth/verify',
    {
      config: { public: true },
      schema: {
        body: {
          type: 'object',
          required: ['phone', 'token'],
          properties: {
            phone: { type: 'string' },
            token: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const body = OtpVerifySchema.parse(request.body)
      // TODO: verify OTP with Twilio, sign JWT
      server.log.info({ phone: body.phone }, 'OTP verify attempted')
      return reply.code(200).send({ token: 'placeholder' })
    },
  )
}
