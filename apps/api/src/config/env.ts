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
  // How many proxy hops sit in front of the API (Railway edge = 1). Drives
  // trustProxy so request.ip = the rightmost X-Forwarded-For entry, i.e. the
  // address the trusted proxy actually saw. NEVER set trustProxy: true —
  // the leftmost XFF entries are client-controlled, so trusting the whole
  // chain lets callers rotate fake IPs past per-IP rate limits. 0 = trust
  // no proxy (request.ip = socket peer).
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SECRET_KEY: z.string().min(1),
  SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  SUPABASE_JWKS_URL: z.string().url(),
  // 32-byte base64 key for AES-256-GCM encryption of payout_destinations.details
  // (generate: openssl rand -base64 32). Decoded once here so the rest of the
  // app only ever sees a validated Buffer.
  DETAILS_ENCRYPTION_KEY: z
    .string()
    .min(1)
    .transform((v) => Buffer.from(v, 'base64'))
    .refine((b) => b.length === 32, 'must be 32 bytes of base64'),
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
  // Quote pricing knobs (slice 3). Fee = flat + bps of send (residual rule in
  // services/quotes.ts); buffer is subtracted from Bridge buy_rate; expiry is
  // our firm-offer window. Bounds keep a fat-fingered env var from quoting a
  // zero/negative rate or a never-expiring offer.
  QUOTE_FEE_FLAT_MINOR: z.coerce.number().int().min(0).default(0),
  QUOTE_FEE_BPS: z.coerce.number().int().min(0).max(9999).default(100),
  QUOTE_FX_BUFFER_BPS: z.coerce.number().int().min(0).max(9999).default(50),
  QUOTE_EXPIRY_SECONDS: z.coerce.number().int().min(60).max(86400).default(900),
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
