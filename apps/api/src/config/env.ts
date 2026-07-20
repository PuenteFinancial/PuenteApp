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
  // Funding (slice 4). 'stripe' joins the enum in slice 4b when keys exist.
  FUNDING_PROCESSOR: z.enum(['mock']).default('mock'),
  // Webhook HMAC secret for the mock processor. ABSENT IN PRODUCTION on
  // purpose — its absence 503s the funding webhook and confirm, which is the
  // production lock against mock funding. Doppler sets it dev/staging only.
  MOCK_FUNDING_WEBHOOK_SECRET: z.string().min(16).optional(),
  // funding_cleared gate policy — recorded this slice, never gated on until
  // the risk engine flips it. NOT z.coerce.boolean(): that parses 'false' as
  // true; the enum-transform is exact.
  WAIT_FOR_CLEARING: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  CANCEL_WINDOW_MINUTES: z.coerce.number().int().min(1).max(1440).default(30),
  // Direct Postgres connection for pg-boss (worker only — the API stays
  // PostgREST-only). Must be the Supabase SESSION-mode pooler (port 5432),
  // never transaction mode (6543) — pg-boss needs session semantics.
  // Optional here so the API boots without it; the worker asserts at startup.
  DATABASE_URL: z.string().min(1).optional(),
  // Bridge treasury wallet (USDC source for payouts). Worker asserts at
  // startup; the API never submits payouts so it can boot without it.
  BRIDGE_TREASURY_WALLET_ID: z.string().min(1).optional(),
  // Crude aggregate float ceiling (slice-5 decision 4): payout submission
  // pauses while the funding_receivable balance is at or above this cap,
  // self-healing as the balance drains — no hold reason is set. The submit
  // job requires it in the worker; unset elsewhere is fine.
  FLOAT_CEILING_MINOR: z.coerce.number().int().min(0).optional(),
  // FX submission backstop: max |live buy_rate − quote source_rate| drift in
  // basis points before the submit job holds the transfer (fx_drift). 10000
  // bps = 100% — anything beyond that is a config typo, not a market move.
  FX_MAX_DRIFT_BPS: z.coerce.number().int().min(0).max(10000).default(200),
  // FX submission backstop: max quote age before the submit job holds the
  // transfer (fx_drift). Fires only on transfers stuck for hours.
  FX_MAX_QUOTE_AGE_MINUTES: z.coerce.number().int().min(1).default(240),
  // Cadence of the payout.poll Bridge reconciliation cron. 300 in prod;
  // set 60 in dev via env. Floor of 10 keeps a fat-fingered value from
  // hammering the Bridge API.
  WORKER_POLL_INTERVAL_SECONDS: z.coerce.number().int().min(10).default(300),
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
