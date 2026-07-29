import * as Sentry from '@sentry/node'
import { env } from '../config/env.js'
import { supabaseAdmin } from '../services/supabase.js'

// Cron watch (`ledger.correction-watch`, hourly): the aggregate trend guard on
// Reg E correction double-pays (slice-7 debt pass).
//
// Every correction payment is individually human-approved (resolve-cancellation
// CLI) and individually paged when it becomes owed — but nothing totals them.
// The loss_cancellation_correction account exists precisely so "what did Reg E
// cost us" is answerable without a join (decisions.md 2026-07-28); this job
// asks that question on a rolling window and pages when the answer crosses a
// threshold. A trip is a TREND signal, not a breakage: each underlying payment
// was deliberate, and the alert exists so nobody has to notice a pattern by
// memory. Fine at pilot scale was the old answer; this is the mechanism that
// says when it stops being fine.
//
// Reads fail CLOSED throughout: a broken read throws (worker handle() reports
// to Sentry and pg-boss's next tick retries) — it must never present as "no
// corrections". Two queries instead of an embedded-resource join on purpose:
// a typo'd account code in a join filter returns an empty set indistinguishable
// from a quiet week, while `.single()` on the account lookup throws loudly if
// the seeded account is ever missing.
export async function watchLossCorrections(): Promise<number> {
  const { data: account, error: accountError } = await supabaseAdmin
    .from('ledger_accounts')
    .select('id')
    .eq('code', 'loss_cancellation_correction')
    .single()
  if (accountError || account == null) {
    throw new Error(
      `correction-watch account lookup failed: ${accountError?.message ?? 'no row returned'}`,
    )
  }

  const cutoff = new Date(
    Date.now() - env.LOSS_CORRECTION_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString()
  const { data, error } = await supabaseAdmin
    .from('ledger_entries')
    .select('amount_minor, direction')
    .eq('account_id', (account as { id: string }).id)
    .gte('created_at', cutoff)
  if (error || data == null) {
    throw new Error(
      `correction-watch entries query failed: ${error?.message ?? 'no rows returned'}`,
    )
  }

  // Signed sum, normal-balance convention for a debit-normal expense account
  // (mirrors ledger_account_balance): debits grow the loss; a credit — the
  // append-only ledger's way of reversing an erroneous correction — shrinks
  // it. A debit-only sum would keep alarming on money already clawed back.
  const entries = data as Array<{ amount_minor: number; direction: 'debit' | 'credit' }>
  let totalMinor = 0
  for (const entry of entries) {
    totalMinor += entry.direction === 'debit' ? entry.amount_minor : -entry.amount_minor
  }

  if (totalMinor >= env.LOSS_CORRECTION_ALERT_MINOR) {
    Sentry.withScope((scope) => {
      // GLOBAL fingerprint (float-ceiling model): the condition is systemic,
      // and the hourly re-fire while over threshold collapses into ONE Sentry
      // issue per episode — resolving it while still over reopens next tick,
      // which is the point. No persisted alert state needed.
      scope.setFingerprint(['loss-correction-threshold'])
      scope.setContext('loss_correction_threshold', {
        windowDays: env.LOSS_CORRECTION_WINDOW_DAYS,
        totalMinor,
        thresholdMinor: env.LOSS_CORRECTION_ALERT_MINOR,
        correctionCount: entries.length,
        runbook: 'docs/runbooks/pending-cancellation.md',
      })
      Sentry.captureMessage('Reg E correction losses at/above aggregate threshold', 'warning')
    })
  }

  return entries.length
}
