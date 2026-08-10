# Proposal — Worker Liveness & Transient-Error Resilience

**Date:** 2026-08-10 · **Status:** ⚠️ **PROPOSAL — not adopted.** Scoped in response to two incidents; no code written.
**Motivating incidents:** the 08-02 silent worker outage and the 08-09/10 Supabase edge cluster.
**Related:** `docs/runbooks/reconciliation.md`, `apps/api/src/worker.ts`, `apps/api/src/services/queue.ts`

## Why now

Two failures three days apart, opposite in shape, both invisible in the way that matters:

| | 08-02 → 08-03 | 08-09 → 08-10 |
|---|---|---|
| What happened | Worker stopped creating jobs entirely | Supabase edge flaked ~4h |
| Duration | ~22.4 hours | ~4 hours intermittent |
| Sentry events | **0** | **~157** |
| Actual impact | Every cron dead for a day | ~15% of one hour's jobs lost, self-healed |
| How it was found | A missing `reconciliation_runs` row, noticed by accident 5 days later | Email flood |

**The system is loud when nothing is wrong and silent when everything is.** That inversion is the
problem to fix, not either incident individually.

## Root finding: `/health` cannot fail

`apps/api/src/worker.ts:66-77` — the worker's health endpoint returns `200 {"status":"ok"}`
unconditionally. It proves the HTTP server is listening, nothing more. Liveness and pg-boss
readiness are decoupled **on purpose** (comment at :60-65): the endpoint must answer inside
Railway's 30s health-check window even while pg-boss is still retrying its boot, or a
slow-but-recovering start gets killed.

That reasoning is sound and should not be reverted. But its consequence is that a worker which has
stopped processing entirely still reports healthy forever — which is precisely what happened on
08-02, and why Railway never restarted it.

**So the liveness signal cannot live in `/health`.** It has to be something that fails when work
stops, observed from outside the worker.

---

## Workstream A — Liveness heartbeat

### Requirement

The signal must prove **the pg-boss cron dispatcher is still dispatching**, not merely that the
process is alive. On 08-02 the process was up (Railway saw it healthy); what died was job creation.
An in-process timer or a `setInterval` ping would likely have kept firing and reported all-clear.

That constrains the design: **the heartbeat must itself be a pg-boss scheduled job.** If pg-boss
cron dispatch breaks, the heartbeat stops — which is exactly the failure we need to detect.

### Proposed shape

1. **New cron `worker.heartbeat`, every 5 minutes** (`worker.ts` schedule block, alongside the
   existing crons). Frequency chosen so a missed beat is detectable within ~15 min without adding
   meaningful load; `payout.sweep` at 1-min is too chatty for check-in quotas.
2. **The handler does a real DB round-trip** — upsert `updated_at` into a single-row
   `worker_heartbeat` table. A no-op handler would prove the dispatcher works but not that the
   worker can still reach the database; both failed on 08-02.
3. **Sentry Cron Monitors for the alert.** Sentry already ingests from this process and supports
   check-ins with a "missed check-in" alert. A missed beat opens an issue with no new
   infrastructure, no new secret, and no polling service to maintain. This is the recommended
   route — the alternative (an external GitHub Actions cron querying the table) needs DB
   credentials in CI and is strictly more moving parts.
4. **Surface `worker_heartbeat` on the ops page** next to the reconciliation run row. Cheap, and it
   answers "is the worker alive right now?" without opening Sentry.

### Explicitly rejected

- **Making `/health` fail on a stale heartbeat.** Railway would restart the container during any
  provider outage — turning the 08-09 Supabase blip into a restart loop while the DB was
  unreachable anyway. Detection and restart policy should stay separate. If auto-restart is wanted
  later, it should key on the worker being *wedged*, never on a dependency being down.

### Open questions

- Sentry cron-monitor quota/pricing on the current plan — needs checking before committing to a
  5-minute cadence.
- Threshold for "missed": one missed beat is noise (a deploy restarts the worker); two or three
  consecutive is signal. Tune so routine deploys don't page.

---

## Workstream B — Transient-error resilience

### The 157 events, by source

| Sentry issue | Events | Origin |
|---|---|---|
| NODE-E | 136 | `boss.on('error')` in `services/queue.ts:76` — pg-boss background/connection failures |
| NODE-G/M/F/N | ~17 | pg-pool connect timeouts, same handler path |
| NODE-P/K/J/3 | 5 | Worker job selects: `TypeError: fetch failed` thrown from `payout-sweep.ts:33`, `payout-poll.ts`, `reconcile-pending.ts`, `stuck-watch.ts` |

Two distinct call sites, two different fixes.

### B1 — `boss.on('error')` is an unconditional firehose

`services/queue.ts:76` is `boss.on('error', (err) => Sentry.captureException(err))`. It cannot
distinguish "Supabase is unreachable for four hours" (136 identical events, zero action available)
from a genuine pg-boss fault. The listener itself must stay — without it, EventEmitter semantics
crash the process — but it should classify before reporting:

- Transient connection classes (`Connection terminated due to connection timeout`,
  `timeout exceeded when trying to connect`, `ECONNRESET`, `fetch failed`) → report at `warning`,
  and **de-duplicate**: report the first occurrence and then a rolled-up count, not every event.
- Everything else → unchanged, `error`.

### B2 — Worker selects should ride out a blip

A `withTransientRetry` helper (sibling to the existing `utils/boot-retry.ts`, which is the right
precedent and shape) wrapping the Supabase selects in the four cron jobs:

- **3 attempts, exponential backoff with jitter.**
- **Retry only transient classes.** Never retry a 4xx or a PostgREST schema error — a real bug must
  still fail fast and loudly. Misclassifying a bug as transient is the main risk here.
- **Hard constraint: total retry budget must stay well under the cron interval.** `payout.sweep`
  runs every 60s; a retry chain longer than that stacks overlapping runs. Budget ~5s, not ~30s.
- Cron jobs already use `retryLimit: 0` ("the next tick is the retry", `queue.ts:47`). In-handler
  retry is for riding out a 2-second blip; the next tick still covers anything longer. These
  compose — don't replace the tick-level recovery.

### The sequencing constraint that matters

**Do A before B.** Every one of those 157 events was noise, but they were also the only reason
anyone would have looked at the worker at all. Quieting them before a liveness signal exists trades
a known false-positive problem for an unknown false-negative one — and the 08-02 incident is proof
that false negatives here cost a full day of blindness.

Heartbeat first. Then quiet the noise.

## Scope boundaries

- **Not** changing pg-boss pool config. Two prior investigations argue against it, and the 08-09
  cluster was not `EMAXCONNSESSION`.
- **Not** attempting to prevent Supabase edge failures — they are the provider's, and the correct
  response is to absorb and report them proportionately.
- **Not** root-causing 08-02. Railway log retention has expired; that evidence is gone. The
  hypothesis worth carrying (untested) is that 08-02 was the same edge failure, long enough that
  pg-boss never recovered its pool. If a third cluster lands, capture logs while fresh and test it.

## Rough size

| | |
|---|---|
| A — heartbeat job, table, migration, Sentry monitor, ops-page row | ~half a session; one migration, `financial-schema-checklist` does not apply (no money, no PII) |
| B1 — classify + roll up `boss.on('error')` | small, self-contained, unit-testable |
| B2 — `withTransientRetry` + four call sites | small; the classifier is the part that needs real test coverage |

Suggested split: **A as one PR, B1+B2 as a second.** Keeps the liveness change reviewable on its
own and preserves the ordering above.
