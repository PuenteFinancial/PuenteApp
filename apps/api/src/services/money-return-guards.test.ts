import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

// GUARD COVERAGE ACROSS THE MONEY-RETURN PATHS.
//
// Four code paths hand a sender their money back, and three guards are supposed
// to apply to all of them. As of 2026-09-15 no two of those guards covered the
// same set of paths — and every gap was a copy-adapt that dropped a line, not a
// decision:
//
//   #339 added the dispute interlock to ops-cancel.
//   #346 added it to the refund tail, one grep short of the third.
//   The third (cancellation-review) shipped without it for six days, on the
//   path where a chargeback is MOST likely, because nothing anywhere said which
//   paths were supposed to have it.
//
// This test is that missing statement. It exists because the failure mode is
// not a bug in any one file — it is a fifth path being written by pattern-
// matching a fourth that was already missing something. A reviewer cannot catch
// that by reading the diff; the diff looks exactly like its neighbours.
//
// Two halves, and the first is the load-bearing one:
//   1. DISCOVERY — anything that disburses must be a path we have declared.
//      A new tail cannot appear without this failing.
//   2. COVERAGE — each declared path carries each guard, unless its absence is
//      recorded in EXEMPT with a reason. An exemption must be TRUE: fix the gap
//      without deleting its entry and this fails too, so the list cannot rot
//      into a list of excuses.
//
// The scan is textual on purpose, the same posture as routes/schema-pii.test.ts.
// It cannot prove a guard is reached on every branch — the behavioural tests in
// each service do that, and each of those was verified by removing its guard and
// watching it fail. What this proves is the thing no unit test can: that the SET
// of paths and the SET of guards still line up.

const SERVICES_DIR = dirname(fileURLToPath(import.meta.url))
const SRC_DIR = join(SERVICES_DIR, '..')

/** A call that hands money back through a funding processor. */
const DISBURSES = /\.(refund|voidFunding)\(\{/

/**
 * Adapters implement `refund`/`voidFunding`; they do not decide whether to call
 * them. Excluded by directory rather than by name so a new adapter is covered
 * automatically.
 */
const ADAPTER_DIR = join(SRC_DIR, 'services', 'funding')

const GUARDS = {
  /**
   * One lock, so two runs cannot disburse the same refund. Its own comment:
   * "two claim implementations would be two chances to get it subtly wrong."
   */
  claimRefund: 'claimRefund(',
  /**
   * "Did the card network already take this money back?" A chargeback has
   * already made the sender whole; paying on top of it pays them twice.
   */
  verifyFundingNotDisputed: 'verifyFundingNotDisputed(',
  /**
   * "Can this rail actually send the money, or does a human have to?" The manual
   * and onramp rails answer `pending` — booking REFUNDED over that tells the
   * sender they were made whole when nobody has sent anything.
   */
  undoRequiresManualDisbursement: 'undoRequiresManualDisbursement(',
} as const

type Guard = keyof typeof GUARDS

const PATHS: { file: string; what: string }[] = [
  { file: 'services/refunds.ts', what: 'refundPayoutFailure — the PAYOUT_FAILED tail' },
  { file: 'services/ops-cancel.ts', what: 'cancelHeldTransfer — the undeliverable-payout exit' },
  { file: 'services/cancellation-review.ts', what: 'refundCancellation — the Reg E correction' },
  { file: 'routes/v1/transfers.ts', what: "the sender's own cancel route" },
]

/**
 * Every guard a path does NOT carry, with why. An entry here is a claim about
 * the code, and the test checks it: remove the gap and you must remove the
 * entry.
 */
const EXEMPT: Record<string, Partial<Record<Guard, string>>> = {
  'services/refunds.ts': {
    undoRequiresManualDisbursement:
      'KNOWN GAP (B6). On a manual or onramp rail this tail settles REFUNDED for money nobody has ' +
      'sent yet. Its resting state, PAYOUT_FAILED, is inside reconciliation AGING_OR_FILTER, so the ' +
      'row stays visible meanwhile — which is why this is a lie to the sender rather than a lost row.',
  },
  'services/cancellation-review.ts': {
    undoRequiresManualDisbursement:
      'KNOWN GAP (B6), same shape as the refund tail. Resting state UNDER_REVIEW is also inside ' +
      'AGING_OR_FILTER.',
  },
  'routes/v1/transfers.ts': {
    claimRefund:
      'DELIBERATE. This path guards differently: a write-once `.is(refund_payment_ref, null)` update ' +
      'plus the processor\'s own `:void` idempotency key. It is the only path whose undo is a void ' +
      'rather than a refund, and the two use different processor sub-keys, so they would not dedupe ' +
      'against each other at the provider even if both ran. Worth revisiting if a second writer ever ' +
      'reaches this row concurrently.',
    verifyFundingNotDisputed:
      'DELIBERATE, on reachability. This is the sender cancelling inside the 30-minute Reg E window; ' +
      'a card dispute takes days to arrive, so there is effectively no funding to have been clawed ' +
      'back yet. Revisit if the cancel window is ever widened.',
  },
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return full.startsWith(ADAPTER_DIR) ? [] : walk(full)
    return full.endsWith('.ts') && !full.endsWith('.test.ts') ? [full] : []
  })
}

const read = (file: string) => readFileSync(join(SRC_DIR, file), 'utf8')

describe('money-return guard coverage', () => {
  it('every file that disburses is a declared money-return path', () => {
    const disbursing = walk(SRC_DIR)
      .filter((file) => DISBURSES.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC_DIR, file).split('\\').join('/'))
      .sort()

    // If this fails with a NEW file: you have written a fifth way to hand a
    // sender their money back. Add it to PATHS, then satisfy the coverage test
    // below — or record why each guard does not apply. Do not delete this
    // assertion; it is the only thing standing between a new tail and the three
    // guards it has not heard of.
    expect(disbursing).toEqual(PATHS.map((p) => p.file).sort())
  })

  it.each(PATHS)('$what carries every guard, or records why not', ({ file }) => {
    const source = read(file)
    const missing = (Object.keys(GUARDS) as Guard[]).filter((g) => !source.includes(GUARDS[g]))
    const exempted = Object.keys(EXEMPT[file] ?? {}).sort()

    expect(missing.sort()).toEqual(exempted)
  })

  it('no exemption outlives the gap it describes', () => {
    // The half that keeps EXEMPT honest. A guard that gets added without its
    // entry being deleted leaves a comment claiming a gap that is closed —
    // which is exactly the class of stale cross-file claim that produced the
    // original bug.
    for (const [file, entries] of Object.entries(EXEMPT)) {
      const source = read(file)
      for (const guard of Object.keys(entries) as Guard[]) {
        expect(
          source.includes(GUARDS[guard]),
          `${file} now calls ${guard} — delete its EXEMPT entry`,
        ).toBe(false)
      }
    }
  })

  it('every declared path still exists', () => {
    for (const { file } of PATHS) expect(() => read(file)).not.toThrow()
  })
})
