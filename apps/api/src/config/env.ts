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
  // This API's own public base URL, no trailing slash (e.g.
  // https://puenteapi-staging.up.railway.app).
  //
  // Needed because the mobile KYC flow hands Bridge a URL pointing back HERE:
  // Bridge's ToS page finishes with a client-side `location.href`, and iOS does
  // NOT surface that to ASWebAuthenticationSession when the target is a custom
  // scheme — verified on a simulator 2026-08-11. An HTTP 302 to the same scheme
  // IS intercepted, so the return leg goes Bridge → this API → 302 → puente://.
  //
  // Optional so the API still boots without it and web is untouched; the mobile
  // branch of /v1/users/me/tos-link fails loudly instead. Deriving it from the
  // request Host header was rejected: that header is client-controlled, and this
  // value becomes a redirect target handed to a third party.
  PUBLIC_API_URL: z.string().url().optional(),
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
  // Per-phone budget on POST /v1/auth/otp/send — the endpoint is public,
  // unauthenticated, and every call is a billed SMS. Enforced in one atomic
  // statement by the otp_attempt_admit function (services/otp-rate-limit.ts);
  // windows are rolling, not calendar, for the same boundary-game reason as the
  // RISK_* caps below. DEFAULTED rather than required so the control cannot be
  // switched off by omitting configuration.
  //
  // OTP_COOLDOWN_SECONDS must stay >= the client's resend timer, which is
  // OTP_RESEND_COOLDOWN_SECONDS in packages/shared — a server window longer
  // than the client's turns Resend into a button that returns 429.
  OTP_COOLDOWN_SECONDS: z.coerce.number().int().min(0).max(3600).default(60),
  OTP_MAX_PER_HOUR: z.coerce.number().int().min(1).default(5),
  OTP_MAX_PER_DAY: z.coerce.number().int().min(1).default(10),
  BRIDGE_API_KEY: z.string().min(1),
  BRIDGE_API_BASE: z.string().url().default('https://api.bridge.xyz'),
  // Hard deadline on every Bridge HTTP call (AbortSignal.timeout in
  // services/bridge.ts). Without it fetches inherit undici's ~300s defaults —
  // the absence this bound removes is what forced CLAIM_STALE_AFTER_MS to 30
  // minutes (services/refunds.ts, re-derived to 10 alongside this knob). Floor
  // of 1 keeps a fat-fingered 0/blank from aborting every call instantly; cap
  // of 120 keeps the bound far inside the 10-minute refund-claim staleness
  // window, so a merely-slow Bridge call can never age into an abandoned claim.
  BRIDGE_TIMEOUT_SECONDS: z.coerce.number().int().min(1).max(120).default(15),
  // PEM public key issued by Bridge when the webhook endpoint is registered
  // post-deploy — webhook route returns 503 until it is set. Escaped \n
  // sequences are normalized so the PEM can live in a single-line env var.
  BRIDGE_WEBHOOK_PUBLIC_KEY: z
    .string()
    .min(1)
    .transform((v) => v.replace(/\\n/g, '\n'))
    .optional(),
  // Quote pricing knobs (slice 3; reshaped by #193 — the fee is merged into
  // the displayed rate). TWO spreads, deliberately separate knobs:
  //   QUOTE_MARGIN_BPS    = REVENUE — Puente's take, booked to fee_revenue via
  //                         margin_minor
  //   QUOTE_FX_BUFFER_BPS = RISK — covers market drift across the firm-quote
  //                         window (Bridge offers no rate lock)
  // Blending them into one number would make fx_slippage unreadable: the P&L
  // could no longer tell margin from market movement. The buffer is subtracted
  // from Bridge buy_rate; the margin folds in as the principal/send ratio
  // (services/quotes.ts); expiry is our firm-offer window. Bounds keep a fat-fingered env var from quoting a zero/negative
  // rate or a never-expiring offer. QUOTE_FEE_FLAT_MINOR / QUOTE_FEE_BPS are
  // gone: quotes now price fee_amount_minor = 0 always.
  QUOTE_MARGIN_BPS: z.coerce.number().int().min(0).max(9999).default(100),
  QUOTE_FX_BUFFER_BPS: z.coerce.number().int().min(0).max(9999).default(50),
  QUOTE_EXPIRY_SECONDS: z.coerce.number().int().min(60).max(86400).default(900),
  // Funding (slice 4; 'stripe' joined in PR-S1, 'manual' in the out-of-band
  // funding slice). Selecting 'stripe' requires both STRIPE_* secrets —
  // enforced by the superRefine below, so a half-configured stripe selection
  // refuses to boot instead of 503ing at the first confirm. 'manual' takes no
  // secrets: the sender moves USD by a rail we don't operate and an allowlisted
  // operator asserts it landed, so its gate is OPS_ADMIN_USER_IDS (checked by
  // ManualFundingProcessor.isConfigured) rather than a key. Prod stays 'mock'
  // (and therefore inert — see the mock secret note) until Joshua flips Doppler.
  FUNDING_PROCESSOR: z.enum(['mock', 'stripe', 'manual']).default('mock'),
  // How long a CONFIRMED transfer may sit in PENDING_PAYMENT under the manual
  // processor before the reconcile sweep declares it abandoned. Webhook-driven
  // processors keep the 30-minute rule (payment either happened or it didn't);
  // out-of-band senders wire money on their own schedule, so the manual rail
  // gets a days-scale window. The stale-quote FX gate at submit still protects
  // the economics of a late-funded transfer.
  MANUAL_PENDING_MAX_AGE_DAYS: z.coerce.number().int().min(1).max(30).default(7),
  // Webhook HMAC secret for the mock processor. ABSENT IN PRODUCTION on
  // purpose — its absence 503s the funding webhook and confirm, which is the
  // production lock against mock funding. Doppler sets it dev/staging only.
  MOCK_FUNDING_WEBHOOK_SECRET: z.string().min(16).optional(),
  // Stripe (PR-S1): secret key (sk_test_… until activation; sk_live_… after)
  // and the webhook endpoint signing secret (whsec_…). Optional here — only a
  // FUNDING_PROCESSOR=stripe selection requires them (superRefine below).
  STRIPE_SECRET_KEY: z.string().min(1).optional(),
  STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
  // Publishable key (pk_test_…/pk_live_…) — served to the web by the
  // funding-session endpoint (PR-S3) so the browser can mount the Payment
  // Element. Public by design, but it lives here (not a NEXT_PUBLIC_ build-time
  // var) so processor selection and key stay co-located and the mock/stripe
  // branch stays server-driven. Required alongside the two secrets when
  // FUNDING_PROCESSOR=stripe: a stripe selection whose web can never render the
  // pay step is a misconfiguration, so it fails at boot like the others.
  STRIPE_PUBLISHABLE_KEY: z.string().min(1).optional(),
  // Hard deadline on every Stripe SDK call, same contract and bounds as
  // BRIDGE_TIMEOUT_SECONDS: the funding seam's timeout contract feeds the
  // 10-min CLAIM_STALE_AFTER_MS derivation in services/refunds.ts, so an
  // unbounded adapter call could make a live refund read as abandoned. The
  // SDK multiplies this by (maxNetworkRetries+1) in the worst case — still
  // minutes inside the staleness window at the 120 cap.
  STRIPE_TIMEOUT_SECONDS: z.coerce.number().int().min(1).max(120).default(15),
  // Explicit opt-in for the dev-only routes (slice 7 PR3: simulate-funding,
  // which drives PENDING_PAYMENT→FUNDED — a real ledger batch — with no real
  // payment). Same fail-closed enum shape as WAIT_FOR_CLEARING / AUTO_REFUND,
  // and deliberately NOT keyed on NODE_ENV: nothing in this repo sets NODE_ENV
  // for the deployed API (railway.toml has no env block), so `NODE_ENV !==
  // 'production'` would be a fail-OPEN predicate — an unset var parses to
  // 'development' and silently opens the gate. This must be positively set,
  // dev/staging only, alongside MOCK_FUNDING_WEBHOOK_SECRET.
  ENABLE_DEV_ENDPOINTS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // funding_cleared gate policy — recorded this slice, never gated on until
  // the risk engine flips it. NOT z.coerce.boolean(): that parses 'false' as
  // true; the enum-transform is exact.
  WAIT_FOR_CLEARING: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  CANCEL_WINDOW_MINUTES: z.coerce.number().int().min(1).max(1440).default(30),
  // Slice-6 PR2 payout-failure refund gate — mechanism now, policy via flag
  // (same shape as WAIT_FOR_CLEARING; NOT z.coerce.boolean, which parses
  // 'false' as true). OFF (prod default): a real payout failure stops at
  // PAYOUT_FAILED + an ops Sentry alert and a human triggers the refund by
  // runbook. ON (dev/test): the payment-event.process job auto-drives the
  // PAYOUT_FAILED → REFUNDED refund-from-float so the e2e proves the full path.
  // Flip on in prod once Bridge return semantics are pilot-verified (slice 7).
  AUTO_REFUND: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // First-transfer hold (slice-8 O3) — mechanism now, policy via flag (same
  // shape as WAIT_FOR_CLEARING; NOT z.coerce.boolean, which parses 'false' as
  // true). OFF (pilot default): the trusted-five's first sends front instantly
  // like any other. ON: a sender with no cleanly cleared send yet
  // (hasClearedHistory) waits for their OWN funding_cleared before the MXN
  // payout submits — no hold reason, the 1-min sweep resumes it on settlement.
  // Flip on with real R01 return data in hand, before widening past the
  // trusted five.
  FIRST_TRANSFER_HOLD: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
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
  // Read-only ops page allowlist (slice 8.5-v1): comma-separated user UUIDs
  // permitted to call GET /v1/ops/overview. FAIL-CLOSED — unset/empty means
  // NOBODY (the route is not even registered), and non-members get 404, never
  // 403 (dev-route posture: the surface must not confirm it exists). This is
  // the v1 stopgap; 8.5-v1.1's real admin-auth design supersedes it.
  OPS_ADMIN_USER_IDS: z
    .string()
    .optional()
    .transform((v) =>
      v == null
        ? new Set<string>()
        : new Set(
            v
              .split(',')
              .map((id) => id.trim())
              .filter(Boolean),
          ),
    ),
  // Ops write capability (slice 8.5-v1.1): second control of the double-control
  // gate on POST /v1/ops/cancellations/resolve. Identity (OPS_ADMIN_USER_IDS)
  // and capability (this flag) are set independently in Doppler, so staging can
  // carry the allowlist with writes off, and a leaked allowlisted session alone
  // cannot move money on an environment where writes are dark. Same fail-closed
  // enum shape as ENABLE_DEV_ENDPOINTS, and deliberately NOT keyed on NODE_ENV
  // (unset NODE_ENV would make that predicate fail-OPEN — see the comment
  // there). The write route is not registered unless BOTH controls are set.
  OPS_WRITE_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // FX submission backstop: max |live buy_rate − quote source_rate| drift in
  // basis points before the submit job holds the transfer (fx_drift). 10000
  // bps = 100% — anything beyond that is a config typo, not a market move.
  FX_MAX_DRIFT_BPS: z.coerce.number().int().min(0).max(10000).default(200),
  // FX submission backstop: max quote age before the submit job holds the
  // transfer (fx_drift). Fires only on transfers stuck for hours.
  FX_MAX_QUOTE_AGE_MINUTES: z.coerce.number().int().min(1).default(240),
  // Per-user transaction limits (slice-7 PR5) — the AML "Transaction Limits at
  // Launch" policy: a per-transaction send cap plus rolling-window send-amount
  // caps (day / month / 6 months) and a belt-and-suspenders per-day send count.
  // All amounts are the SEND principal in USD minor units (fees excluded — the
  // policy caps the amount transmitted). DEFAULTED to the launch values so the
  // control stays on even if unset (fail-closed); the per-user counterpart to the
  // aggregate FLOAT_CEILING_MINOR. Names track the ERD `user_limits` columns
  // (per_transfer / daily / monthly) for the slice-8 lift; the 6-month tier is
  // beyond the ERD today. Windows are rolling 30/180 days, not calendar periods.
  RISK_PER_TXN_MAX_MINOR: z.coerce.number().int().min(0).default(150_000), // $1,500 per transfer
  RISK_DAILY_MAX_MINOR: z.coerce.number().int().min(0).default(150_000), // $1,500 / rolling 24h
  RISK_MONTHLY_MAX_MINOR: z.coerce.number().int().min(0).default(300_000), // $3,000 / rolling 30d
  RISK_SEMIANNUAL_MAX_MINOR: z.coerce.number().int().min(0).default(1_800_000), // $18,000 / rolling 180d
  RISK_VELOCITY_MAX_COUNT: z.coerce.number().int().min(1).default(5), // sends / rolling 24h
  // Uncleared-exposure cap (slice-8 O3): max committed sends in flight per user
  // before their ACH pulls settle — counted from disclosure acceptance until
  // funding_cleared (or unwind), no time window. The per-user count axis of the
  // aggregate FLOAT_CEILING_MINOR. Floor of 1: the comparison is `>=`, so 0
  // would block every send.
  RISK_UNCLEARED_MAX_COUNT: z.coerce.number().int().min(1).default(1), // uncleared sends in flight
  // Aggregate Reg E correction-loss trend guard (ledger.correction-watch cron):
  // page when the rolling-window signed sum of loss_cancellation_correction
  // reaches this. HARD defaults (RISK_* style, not FLOAT_CEILING's
  // required-at-use) so the tripwire stays armed even when unset. $200 ≈ one
  // max-size correction at launch limits — fires around the second one. Floor
  // of 1: at 0 the >= comparison pages every hour on an EMPTY window (0 >= 0).
  LOSS_CORRECTION_ALERT_MINOR: z.coerce.number().int().min(1).default(20_000), // $200 / window
  // Rolling window for that sum. The cap keeps a fat-fingered value from
  // turning the hourly select into an unbounded scan as entries accumulate.
  LOSS_CORRECTION_WINDOW_DAYS: z.coerce.number().int().min(1).max(90).default(7),
  // Cadence of the payout.poll Bridge reconciliation cron. 300 in prod;
  // set 60 in dev via env. Floor of 10 keeps a fat-fingered value from
  // hammering the Bridge API.
  WORKER_POLL_INTERVAL_SECONDS: z.coerce.number().int().min(10).default(300),
  // Stuck-transfer dwell thresholds (transfers.stuck-watch cron, slice-8 O1):
  // how long a transfer may sit in a state before it pages as stuck. HARD
  // defaults (LOSS_CORRECTION_* style) so the pager stays armed even when
  // unset; the defaults encode expected process timing (submission in seconds,
  // Bridge accept in seconds-to-minutes, SPEI settlement in seconds). Floor of
  // 1 everywhere: 0 would page every non-terminal transfer on every tick.
  STUCK_FUNDED_AFTER_MINUTES: z.coerce.number().int().min(1).default(15),
  STUCK_SUBMITTED_AFTER_MINUTES: z.coerce.number().int().min(1).default(30),
  STUCK_IN_FLIGHT_AFTER_MINUTES: z.coerce.number().int().min(1).default(60),
  // The "dumb >1-business-day" UNDER_REVIEW age alert — calendar-blind by
  // design (weekend false positives accepted); statutory-clock tracking waits
  // for counsel's error-resolution process adoption.
  STUCK_UNDER_REVIEW_AFTER_HOURS: z.coerce.number().int().min(1).default(24),
  // No TWILIO_* vars here on purpose. The API never calls Twilio: phone OTP
  // goes through Supabase Auth (`signInWithOtp({ channel: 'sms' })`), and
  // GoTrue holds the Twilio account SID / auth token / Messaging Service SID
  // in the Supabase dashboard, per project. Three optional TWILIO_* vars used
  // to be declared here and were read by nothing — setting them in Doppler
  // looked like configuring SMS while changing precisely nothing.
  SENTRY_DSN: z.string().url().optional(),
  // Declared here for validation + documentation only — instrument.ts reads it
  // straight off process.env, because Sentry.init must run before anything
  // imports this module.
  SENTRY_ENVIRONMENT: z.string().min(1).optional(),
})

// Exported for tests; runtime uses the singleton `env` below.
export const envSchemaWithRules = envSchema.superRefine((value, ctx) => {
  if (value.FUNDING_PROCESSOR === 'stripe') {
    for (const key of [
      'STRIPE_SECRET_KEY',
      'STRIPE_WEBHOOK_SECRET',
      'STRIPE_PUBLISHABLE_KEY',
    ] as const) {
      if (!value[key]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} is required when FUNDING_PROCESSOR=stripe`,
        })
      }
    }
  }
  // Manual funding auto-creates the Bridge onramp at confirm (slice 3), and the
  // onramp's destination is the treasury wallet — a manual selection without it
  // would accept confirms whose onramp job can never succeed. Same fail-at-boot
  // posture as the stripe key trio.
  if (value.FUNDING_PROCESSOR === 'manual' && !value.BRIDGE_TREASURY_WALLET_ID) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['BRIDGE_TREASURY_WALLET_ID'],
      message: 'BRIDGE_TREASURY_WALLET_ID is required when FUNDING_PROCESSOR=manual',
    })
  }
})

const parsed = envSchemaWithRules.safeParse(process.env)

if (!parsed.success) {
  console.error('Invalid environment variables:')
  console.error(parsed.error.flatten().fieldErrors)
  process.exit(1)
}

export const env = parsed.data
