# Puente

Puente is a credit-building remittance app for LATAM immigrants in the US. Live today at
[puentefinancial.com](https://www.puentefinancial.com): waitlist, credit score check, and financial
literacy content. In progress: the USD → MXN remittance MVP — pure money movement on top of Bridge
(the licensed money transmitter), with Stripe collecting USD. Lending is a separate future stack.

**New here? Read [docs/onboarding.md](docs/onboarding.md)** for the access checklist and your
first-week plan. Jargon you don't recognize is probably in the [glossary](docs/glossary.md);
the reasons behind non-obvious choices are in the [decision log](docs/decisions.md).

## Repo map

Turborepo monorepo, pnpm workspaces:

| Path | What | Stack |
|---|---|---|
| `apps/api` | The API — the only thing that talks to the DB and to providers | Fastify v5, TypeScript, Zod, Supabase (Postgres) |
| `apps/web` | Marketing site + waitlist + onboarding web flows | Next.js, Vercel |
| `apps/mobile` | The app (remittance MVP target) | React Native, Expo SDK 56, NativeWind, expo-router |
| `packages/shared` | Types defined once, imported everywhere (`@puente/shared`) — incl. the `Money` type | TypeScript |
| `docs/` | Design docs, runbooks, PRDs — see reading order below | — |
| `supabase/migrations/` | Schema migrations (applied only via the pipeline) | — |

## First hour

```bash
pnpm install
pnpm run typecheck        # should be green before you touch anything
cd apps/api && pnpm test  # API tests (Vitest + Supertest)
```

To actually run the stack, follow [docs/runbooks/local-dev.md](docs/runbooks/local-dev.md) — the
default setup points local apps at the staging cloud (safe, no Docker). Two gotchas that bite
everyone once: nothing auto-loads `.env` (`set -a; source .env; set +a; pnpm dev` or use Doppler),
and `apps/web` throws without `INTERNAL_API_URL` in `.env.local`.

## Reading order

1. **[CLAUDE.md](CLAUDE.md)** — written for Claude Code, but it's the densest one-page summary of
   the stack, conventions, and non-negotiable security/money rules. Humans should read it too.
2. **[docs/architecture.md](docs/architecture.md)** — every component and who talks to whom. The
   load-bearing rule: clients never touch the DB or providers; the API is the boundary.
3. **[docs/transfer-state-machine.md](docs/transfer-state-machine.md)** — the spine of the
   remittance system. Everything else hangs off these states.
4. **[docs/erd.md](docs/erd.md)** — the data model behind it.
5. **[docs/ledger-rules.md](docs/ledger-rules.md)** — double-entry postings per state transition.
   This is where money correctness lives.
6. **[docs/api-contract.md](docs/api-contract.md)** — the `/v1` surface for the send-money flow.
7. **[docs/flows.md](docs/flows.md)** — sequence diagrams tying 2–6 together.
8. **[docs/runbooks/](docs/runbooks)** — how we deploy, migrate, and run locally.
   (`docs/runbooks/proposals/` are unadopted drafts — don't treat them as policy.)

Also: [docs/pre-implementation-todo.md](docs/pre-implementation-todo.md) is the gate list for the
remittance MVP, and [docs/prds/](docs/prds) holds the feature PRDs.

## Working here

- **Branches:** `main` = staging (auto-deploys on merge). `production` = what's live; it moves only
  via the approval-gated **Promote** workflow — see
  [docs/runbooks/deploy-and-promote.md](docs/runbooks/deploy-and-promote.md). Feature work goes in
  short-lived branches, PR'd into `main`, squash/rebase only (linear history enforced).
- **Required checks:** `Typecheck, Lint, Test` + Gitleaks secret scan. Run `pnpm run typecheck`
  after any change; write tests alongside implementation, not after.
- **Migrations** only as files in `supabase/migrations/`, applied by the pipeline
  ([docs/runbooks/migrations.md](docs/runbooks/migrations.md)) — never by hand against a remote DB.
- **Money code** follows CLAUDE.md's rules without exception: integer minor units, double-entry
  ledger, idempotency keys, state machines. If you're touching money or auth, a security review
  happens before merge.
- **Secrets** live in Doppler and nowhere else ([docs/runbooks/secrets.md](docs/runbooks/secrets.md)).
  PII never goes in logs or URLs.
- **Diagrams:** docs use Mermaid because GitHub renders it natively. If you prefer PlantUML for
  your own thinking, go for it — just commit the shared docs in Mermaid (or include both).
