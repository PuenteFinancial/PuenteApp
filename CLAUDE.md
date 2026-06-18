# Puente — Claude Code Context

## Project
Fintech monorepo. Credit-building remittance app targeting LATAM immigrants in the US.
MVP: signup, credit score check, financial literacy content.

## Stack
- Monorepo: Turborepo. `apps/mobile` (RN + Expo), `apps/api` (Fastify), `packages/shared` (TS types)
- API: Fastify v4, TypeScript, Zod schema validation, Supabase (Postgres)
- Mobile: Expo SDK 51, expo-router, NativeWind (Tailwind), react-i18next
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
