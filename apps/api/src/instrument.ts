import * as Sentry from '@sentry/node'

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
  environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'development',
})
