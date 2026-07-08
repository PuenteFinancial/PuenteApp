import { z } from 'zod'

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('0.0.0.0'),
  ALLOWED_ORIGINS: z
    .string()
    .default('http://localhost:3000,http://localhost:8081')
    .transform((s) => s.split(',')),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SECRET_KEY: z.string().min(1),
  SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  SUPABASE_JWKS_URL: z.string().url(),
  BRIDGE_API_KEY: z.string().min(1),
  BRIDGE_API_BASE: z.string().url().default('https://api.bridge.xyz'),
  // PEM public key issued by Bridge when the webhook endpoint is registered
  // post-deploy — webhook route returns 503 until it is set. Escaped \n
  // sequences are normalized so the PEM can live in a single-line env var.
  BRIDGE_WEBHOOK_PUBLIC_KEY: z
    .string()
    .min(1)
    .transform((v) => v.replace(/\\n/g, '\n'))
    .optional(),
  TWILIO_ACCOUNT_SID: z.string().min(1).optional(),
  TWILIO_AUTH_TOKEN: z.string().min(1).optional(),
  TWILIO_PHONE_NUMBER: z.string().min(1).optional(),
  SENTRY_DSN: z.string().url().optional(),
})

const parsed = envSchema.safeParse(process.env)

if (!parsed.success) {
  console.error('Invalid environment variables:')
  console.error(parsed.error.flatten().fieldErrors)
  process.exit(1)
}

export const env = parsed.data
