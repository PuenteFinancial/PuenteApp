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
- API: Vitest + Supertest. Run: `pnpm test` from `apps/api/`
- Write tests alongside implementation, not after
- Run `pnpm run typecheck` after any change

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

## Environments

```
feature/* ──PR──▶ main ──auto──▶ staging
                                    │
                              tag v* or manual
                                    │
                                    ▼
                               production
```

| | Local | Preview (per-PR) | Staging | Production |
|---|---|---|---|---|
| Web | localhost:3000 | Vercel preview URL | Vercel (main branch) | Vercel (prod) |
| API | localhost:3001 | → staging API | Railway staging | Railway prod |
| DB | supabase start | → staging DB | Supabase staging project | Supabase prod project |
| Mobile | Expo Go / dev build | — | EAS preview build | EAS production build |

- `main` merges auto-deploy to staging. Production is promoted deliberately (tag or workflow dispatch).
- Preview PRs point at the staging API + DB — no ephemeral API per PR at this stage.
- Two separate Supabase projects: migrations run against staging first, then prod.
- Secrets managed via Doppler, synced to Vercel / Railway / GitHub Actions / EAS.

## Branch model & protection

- `main` is the only long-lived branch. Feature work lives in short-lived branches merged via PR.
- Branch protection on `main`:
  - 0 required reviews (solo — restore to 1 when a collaborator joins)
  - Required status checks: `Typecheck, Lint, Test` + `Gitleaks`
  - Required conversation resolution before merge
  - Linear history required (squash or rebase merges only)
  - No force pushes, no deletion, no admin bypass

## CI

Workflows in `.github/workflows/`:
- `ci.yml` — typecheck, lint, test, `next build` (web). Runs on every PR and push to main. Uses Turborepo remote cache (requires `TURBO_TOKEN` + `TURBO_TEAM` GitHub secrets).
- `secret-scan.yml` — Gitleaks secret scanning. Runs on every PR and push to main.
- `deploy.yml` — Railway API deploy. Disabled (`if: false`) until Railway is connected.
- `claude.yml` — Claude PR assistant (responds to `@claude` in PRs/issues).
- `claude-code-review.yml` — Claude auto-reviews every PR.
- `claude-compliance.review.yml` — Claude security + compliance review on financial/auth paths.

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