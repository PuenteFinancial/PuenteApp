import * as Sentry from '@sentry/node'
import { supabaseAdmin } from './supabase.js'
import {
  renderAccountFrozenNotice,
  type NoticeChannel,
  type NoticeLanguage,
  type NoticeStatus,
  type SenderNoticeKind,
} from './sender-notice-copy.js'

// One import surface for callers and tests: the copy module is an
// implementation detail of this one.
export * from './sender-notice-copy.js'

// The notices the system owes a sender, rendered and recorded.
//
// Today there is exactly one: the account freeze. The loss path suspends a
// sender the moment a chargeback or ACH return lands (services/funding-apply.ts),
// and before this module that freeze was silent — the sender found out on their
// next action, as `account_suspended`. Compliance review 2026-09-10 called
// proactive notice strongly advisable on a UDAAP-unfairness basis: substantial
// injury the consumer cannot reasonably avoid, for a population that may lack
// alternative remittance options.
//
// The copy itself lives next door in sender-notice-copy.ts, which is a pure
// copy table under the no-em-dashes lint rule. This module is the plumbing.
//
// NEVER THROWS, NEVER BLOCKS. By the time this runs the freeze has already
// landed and cannot be unwound, so a failure here is logged and paged, never
// propagated — the same contract as recordOpsAction. A missing notice is a
// compliance problem; a notice that reverses a fraud freeze is a money problem.

interface Logger {
  info(obj: Record<string, unknown>, msg: string): void
  error(obj: Record<string, unknown>, msg: string): void
}

/**
 * Render, store, and raise the account-freeze notice.
 *
 * Idempotency comes from the CALLER: suspendSender only invokes this when its
 * guarded UPDATE actually flipped the row, so a redelivered dispute writes no
 * second notice and raises no second page.
 *
 * Returns whether the row landed. Never rejects.
 */
export async function recordAccountFrozenNotice(
  input: {
    userId: string
    /** The disputed transfer, so the notice ties to the clawback that caused it. */
    transferId: string | null
    language: NoticeLanguage
  },
  log: Logger,
): Promise<boolean> {
  // The outer net. Everything below is already defensive, but "never rejects"
  // has to hold even when the REPORTING fails — a broken logger or an
  // unavailable Sentry transport must not be the thing that 500s a webhook and
  // makes a provider redeliver a dispute we have already acted on.
  try {
    return await writeNotice(input, log)
  } catch {
    return false
  }
}

async function writeNotice(
  input: { userId: string; transferId: string | null; language: NoticeLanguage },
  log: Logger,
): Promise<boolean> {
  const notice = renderAccountFrozenNotice(input.language)
  const channel: NoticeChannel = 'manual'
  const status: NoticeStatus = 'pending'

  try {
    const { error } = await supabaseAdmin.from('sender_notices').insert({
      user_id: input.userId,
      transfer_id: input.transferId,
      kind: 'account_frozen' satisfies SenderNoticeKind,
      language: input.language,
      channel,
      status,
      subject: notice.subject,
      body: notice.body,
    })
    if (error) {
      reportFailure(input.userId, error.code ?? error.message, log)
      return false
    }
  } catch (err) {
    reportFailure(input.userId, err instanceof Error ? err.message : String(err), log)
    return false
  }

  log.info(
    { audit: true, userId: input.userId, transferId: input.transferId, kind: 'account_frozen', language: input.language },
    'account freeze notice recorded — awaiting manual delivery',
  )

  // THE PAGE IS THE DELIVERY MECHANISM, which is the honest description of a
  // 'manual' channel. The reversal itself already pages, but that event is
  // about money; this one is about a person who does not yet know their account
  // stopped, and it carries the exact words to use so the operator does not
  // improvise copy that has not been reviewed.
  //
  // Level 'error' because a human owes an action (payout-holds.ts precedent),
  // and rare by construction: one per freeze, and only on the call that froze.
  // The subject and body are fixed, PII-free copy, so they are safe to attach.
  Sentry.withScope((scope) => {
    scope.setFingerprint(['sender-notice-owed', 'account_frozen', input.userId])
    scope.setContext('notice', {
      userId: input.userId,
      transferId: input.transferId,
      language: input.language,
      channel,
      subject: notice.subject,
      body: notice.body,
    })
    Sentry.captureMessage('account freeze notice owed to sender — deliver it manually', 'error')
  })
  return true
}

function reportFailure(userId: string, detail: string, log: Logger): void {
  // Ids and codes only. The copy is PII-free but the log line has no need of it.
  log.error(
    { userId, kind: 'account_frozen', supabaseError: detail },
    'sender notice write failed — the sender is owed a notice with no record of it',
  )
  Sentry.withScope((scope) => {
    scope.setFingerprint(['sender-notice-write-failed', 'account_frozen'])
    scope.setContext('notice', { userId, kind: 'account_frozen', detail })
    Sentry.captureMessage('sender notice write failed', 'error')
  })
}
