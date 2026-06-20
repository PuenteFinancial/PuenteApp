# Puente — Claude Code Context

## Project
Fintech monorepo. Credit-building remittance app targeting LATAM immigrants in the US.
MVP: signup, credit score check, financial literacy content.

## Stack
- Monorepo: Turborepo. `apps/mobile` (RN + Expo), `apps/api` (Fastify), `packages/shared` (TS types)
- API: Fastify v5, TypeScript 6, Zod schema validation, Supabase (Postgres)
- Mobile: Expo SDK 56, expo-router, NativeWind (Tailwind), react-i18next
- Auth: Supabase Auth + Twilio SMS OTP + JWT
- Credit: CRS Credit API (server-side only — never called from client)
- Analytics: PostHog. Feature flags via PostHog.
- Error monitoring: Sentry
- Deployment: Railway (API), Expo EAS (mobile)

## Shared types
Define types ONCE in `packages/shared/src/types/`. Import everywhere via `@puente/shared`.
Never duplicate type definitions across apps.

## API conventions
- All routes versioned: `/v1/`
- Every route must have Fastify schema validation (input + response shapes)
- Auth middleware on every route unless `config: { public: true }` is explicit
- Audit log entry on every authenticated route (see `apps/api/src/plugins/audit.ts`)
- Services in `apps/api/src/services/` — one file per external integration
- NEVER call CRS, Twilio, or any external API from the mobile client

## Security rules — NON-NEGOTIABLE
- API keys and secrets: server-side only, never in client code or git
- PII (names, phone, SSN, DOB): never logged, never in URL params
- FCRA: credit score endpoint only callable after `fcraConsentAt` is set on user
- Every new route touching financial data needs audit log entry
- Run security-reviewer subagent before merging auth or financial logic

## Mobile conventions
- NativeWind for all styling (Tailwind class names)
- All user-facing strings go through i18next — English + Spanish from day one
- expo-router for navigation (file-based)
- expo-secure-store for any sensitive local storage (tokens, etc.)

## Testing
- API: Vitest + Supertest. Run: `npm test` from `apps/api/`
- Write tests alongside implementation, not after
- Run `npm run typecheck` after any change

## Workflow
- One task per session. `/clear` between unrelated tasks
- Explore → Plan → Implement → Verify (tests + typecheck)
- Commit before every session
- Use security-reviewer subagent before merging auth/financial code
- Use compliance-reviewer subagent before merging any user-facing consent flows

## Money & financial integrity (applies when remittance lands)
- Money is integer minor units + explicit currency. NEVER floats. Type: Money = {amountMinor, currency}
- No mixing currencies without an explicit FX step that records rate + timestamp
- Double-entry ledger is source of truth; balances are derived, never stored mutable
- Every money-moving endpoint takes an idempotency key and is safe to retry
- Transaction lifecycle is an explicit state machine; reversals/refunds are states, not deletes

## Monorepo / Turborepo

Turborepo runs tasks in dependency order and caches outputs by hashing inputs.
- `turbo run build` builds `packages/shared` first (upstream dep), then apps in parallel
- `turbo run typecheck/lint/test` runs across all workspaces; skip unchanged packages via cache
- `turbo.json` controls task ordering (`dependsOn: ["^build"]` = build deps first)

**Root devDependencies — do not remove `react` and `react-dom`.**
They exist at root to prevent `react-native`'s peer dep from hoisting `react@18` above `react@19`
at the workspace root. npm overrides don't apply to auto-installed peer deps; a direct dep does.
Removing them will break Vercel builds with a React version mismatch.

## CI

Workflows in `.github/workflows/`:
- `ci.yml` — typecheck, lint, test, `next build` (web), audit. Runs on every PR and push to main.
- `deploy.yml` — Railway API deploy. Disabled (`if: false`) until Railway is connected.
- `claude.yml` — Claude PR assistant (responds to `@claude` in PRs/issues).
- `claude-code-review.yml` — Claude auto-reviews every PR.
- `claude-compliance.review.yml` — Claude compliance review on PRs.

The `next build` step in CI catches Vercel deploy failures before they happen. env vars are
lazily initialized (request-time only), so the build succeeds in CI without secrets.

## Harness / tooling
- Skills (auto-apply when relevant):
  - `api-route` — every new Fastify route
  - `migration` — every new DB migration
  - `tdd` — every implementation session
  - `feature-flag` — gating new features
  - `i18n` — any user-facing string
  - `ledger` — any route that moves money
  - `adverse-action` — any credit decision that can be negative
  - `furnisher` — any credit bureau reporting or dispute code
  - `fx-rate` — any cross-currency operation
  - `supabase-postgres-best-practices` — any new table or RLS policy
  - `pr-prep` — before opening any PR
- Supabase MCP is available for schema/inspection. NEVER run destructive SQL or
  apply migrations to a remote/prod project via MCP. Write migration files; apply via reviewed pipeline