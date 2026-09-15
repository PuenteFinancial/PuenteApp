import { processorFor } from './funding/index.js'

// The dispute interlock, shared by every path that hands money back to a sender.
//
// It lived in ops-cancel.ts when the ops cancel was the only caller. The refund
// tail needs the SAME question answered before IT disburses, and refunds.ts is
// upstream of ops-cancel (ops-cancel imports claimRefund from it), so importing
// it back would be a cycle. Neutral module, one implementation, both callers.
//
// The parameter is structural on purpose: the two callers load different column
// sets off `transfers` and neither should have to adopt the other's row type to
// ask this question.
export interface DisputeCheckable {
  state: string
  payout_hold_reason: string | null
  funding_disputed_at: string | null
  funding_payment_ref: string | null
  funding_processor?: string | null
}

/**
 * THE DISPUTE INTERLOCK (2026-09-14). Is this funding still ours to give back?
 *
 * Asked before the cancel commits, because a disputed charge has ALREADY
 * returned the sender's money through the card network. Refunding on top of
 * that pays twice; booking a refund the processor will refuse leaves the ledger
 * asserting a debt that does not exist.
 *
 * Two independent sources, and the second is the one that earns the name:
 *
 *   OUR RECORD    `funding_disputed_at`, a `funding_disputed` hold, or the
 *                 FUNDING_REVERSED state. Free to read and usually right — but
 *                 it is a MIRROR of a webhook, and a mirror can be empty. On
 *                 staging three disputes left no trace at all, because the
 *                 handler that writes these fields shipped hours after they
 *                 arrived. A gate that trusted this alone would have passed all
 *                 three.
 *   THE PROVIDER  the live charge. Costs a call and cannot be stale.
 *
 * FAILS CLOSED. A processor that implements getDisputeStatus and then throws —
 * timeout, 5xx, transport — is a refusal, not a pass: silence is not
 * confirmation (verifyPrincipalReturned, same rule). The caller turns the throw
 * into a stop.
 *
 * A rail that does NOT implement getDisputeStatus is a different case, and
 * treating it as a failure would be wrong. The mock cannot be disputed and
 * `manual` collects funds on a rail we do not operate, so there is no question
 * for them to answer — those proceed on our record alone, and `checked` says so
 * rather than leaving the caller to assume the provider was consulted.
 *
 * NOT A SAFETY GUARANTEE, and it should not be described as one. A dispute can
 * land a second after this returns. What makes the operation safe is the refund
 * claim and the ordering; this makes the common failure loud and early instead
 * of a mid-tail throw that strands the row.
 */
export type DisputeVerdict =
  | { disputed: false; checked: 'record_and_provider' | 'record_only' }
  | { disputed: true; source: 'record' | 'provider'; disputeRef: string | null; detail: string }

export async function verifyFundingNotDisputed(
  transfer: DisputeCheckable,
): Promise<DisputeVerdict> {
  // 1) Our record. Cheapest, and decisive when it is set.
  //
  // `!= null`, not `!== null`: an UNDEFINED value means the column was not
  // selected, not that a dispute exists. Strict equality here read every
  // caller that did not ask for the column as disputed and refused the lot —
  // caught by the fixtures the moment this landed. Undefined falls through to
  // the provider half, which is the half that can actually answer.
  if (transfer.funding_disputed_at != null) {
    return {
      disputed: true,
      source: 'record',
      disputeRef: null,
      detail: `funding_disputed_at is set (${transfer.funding_disputed_at})`,
    }
  }
  if (transfer.payout_hold_reason === 'funding_disputed' || transfer.state === 'FUNDING_REVERSED') {
    return {
      disputed: true,
      source: 'record',
      disputeRef: null,
      detail:
        transfer.state === 'FUNDING_REVERSED'
          ? 'the transfer is FUNDING_REVERSED'
          : "the payout is held on 'funding_disputed'",
    }
  }

  // 2) The provider. A null funding ref cannot be looked up — the caller
  //    already refuses such a row before disbursing, so this only avoids
  //    asking an unanswerable question.
  const processor = processorFor(transfer)
  if (!processor.getDisputeStatus || transfer.funding_payment_ref === null) {
    return { disputed: false, checked: 'record_only' }
  }
  // No try/catch: a throw IS the refusal. See the doc comment.
  const live = await processor.getDisputeStatus({ paymentRef: transfer.funding_payment_ref })
  if (live.disputed) {
    return {
      disputed: true,
      source: 'provider',
      disputeRef: live.disputeRef ?? null,
      detail: `the funding charge is disputed at the provider${live.status ? ` (${live.status})` : ''}`,
    }
  }
  return { disputed: false, checked: 'record_and_provider' }
}
