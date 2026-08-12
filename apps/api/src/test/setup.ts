// env.ts validates process.env at import time and exits the process on
// failure, so every required var needs a dummy value before test modules load.
process.env.NODE_ENV = 'test'
process.env.SUPABASE_URL ??= 'https://test-project.supabase.co'
process.env.SUPABASE_SECRET_KEY ??= 'sb_secret_test'
process.env.SUPABASE_PUBLISHABLE_KEY ??= 'sb_publishable_test'
process.env.SUPABASE_JWKS_URL ??= 'https://test-project.supabase.co/auth/v1/.well-known/jwks.json'
// The mobile KYC return leg redirects through this API, so the route needs to
// know its own address. Optional in env.ts, so this only has to be set for the
// tests that exercise the mobile branch.
process.env.PUBLIC_API_URL ??= 'https://api.test.puente'
process.env.BRIDGE_API_KEY ??= 'bridge_test_key'
process.env.BRIDGE_API_BASE ??= 'https://api.bridge.test'
process.env.DETAILS_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64')
process.env.MOCK_FUNDING_WEBHOOK_SECRET ??= 'mock_funding_secret_test'
// Webhook signing secret only — no STRIPE_SECRET_KEY, so tests prove the
// stripe adapter's signature path without ever looking API-key-configured.
process.env.STRIPE_WEBHOOK_SECRET ??= 'whsec_stripe_secret_test'
