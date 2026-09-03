import * as Sentry from '@sentry/node'
import { createDedupeFilter } from './config/sentry-dedupe.js'
import { scrubEvent } from './config/sentry-scrub.js'

// NOTE: this module is the Sentry preload — it runs before config/env.ts is
// imported, so everything here reads process.env directly and must not pull in
// the validated env module.

const environment = process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'development'

// Repeat-suppression window (see config/sentry-dedupe.ts for the why).
//
// Deliberately OFF in production. Suppression trades event fidelity for volume:
// while a key is suppressed the issue's "last seen" goes stale and the event
// count understates the true rate, which would hide the SHAPE of a real prod
// incident (a genuine outage firing 1,000/min would read as 1/hour). Production
// runs ~283 events/30d — it is not the problem, so it pays no fidelity cost.
// Staging, which burned 94% of the quota, is where the window earns its keep.
const dedupeWindowMs =
  environment === 'production'
    ? 0
    : Number(process.env.SENTRY_DEDUPE_WINDOW_MINUTES ?? 60) * 60_000

const shouldSend = createDedupeFilter(dedupeWindowMs)

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  sendDefaultPii: false,
  // SENTRY_ENVIRONMENT first, because NODE_ENV alone cannot tell staging from
  // production: Railway runs NODE_ENV=production in BOTH environments, so every
  // staging event has been arriving tagged `production` (this has already cost
  // real triage time — a staging-only reconciliation finding read as a live
  // prod incident). It also matters for cron monitors: without a distinct
  // environment, staging and prod check in to the same monitor and a dead
  // staging worker is masked by a live prod one.
  environment,
  // Scrub first (K6: identity numbers are redacted by key name wherever the
  // SDK may have picked them up), then apply the repeat-suppression window.
  // The scrubber never touches fingerprint or exception, so dedupe keys are
  // identical for the scrubbed and raw event.
  beforeSend: (event) => {
    const scrubbed = scrubEvent(event)
    return shouldSend(scrubbed, Date.now()) ? scrubbed : null
  },
})
