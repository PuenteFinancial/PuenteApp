import crypto from 'node:crypto'
import { env } from '../../config/env.js'
import type {
  FundingClientSession,
  FundingInitiation,
  FundingParseResult,
  FundingProcessor,
  FundingUndo,
} from './index.js'

// Out-of-band funding: the sender moves USD by a rail Puente does not operate
// (a Bridge onramp deposit funded by FedNow/wire/ACH), and an allowlisted
// operator asserts through POST /v1/ops/transfers/funding that it landed. There
// is no gateway, no client-side payment step, and no inbound webhook — which is
// exactly why this is its own processor rather than the mock with its lock
// removed. The mock's whole purpose is to fabricate funding events on demand;
// letting that into production would mean any signed-in user could mark their
// own transfer funded and trigger a real MXN payout with no money in.
//
// The security boundary is therefore the ops route's double-control gate
// (OPS_ADMIN_USER_IDS + OPS_WRITE_ENABLED), not a shared secret.
export class ManualFundingProcessor implements FundingProcessor {
  readonly provider = 'manual'
  // No webhook exists for this processor. The interface requires a header name;
  // this one is never read, because verifySignature always refuses.
  readonly signatureHeader = 'manual-funding-signature'

  isConfigured(): boolean {
    // Selection alone is not enough. Manual funding is only actionable by an
    // allowlisted operator, so with an empty allowlist NOBODY can move a
    // transfer past PENDING_PAYMENT — and a deployment in that state must 503
    // at confirm rather than accept transfers it can never fund. Read at call
    // time so tests can toggle it on the parsed env object.
    return env.OPS_ADMIN_USER_IDS.size > 0
  }

  async initiateFunding(): Promise<FundingInitiation> {
    // Nothing to create at a processor: the money moves out of band. This just
    // mints the ref persisted to transfers.funding_payment_ref, which the ops
    // action later echoes so the audit trail ties operator assertion to row.
    // `method: 'ach'` is the interface's only value — the real rail (FedNow,
    // wire, ACH) is recorded as the ops action's externalRef, not here.
    return {
      provider: this.provider,
      method: 'ach',
      paymentRef: `manualpay_${crypto.randomUUID()}`,
    }
  }

  async getClientSession(): Promise<FundingClientSession> {
    // No Element to mount and no button to press — the web renders the deposit
    // instructions and a waiting state off `provider` alone (payStep.ts).
    return { provider: this.provider, fields: {} }
  }

  verifySignature(): boolean {
    // Manual funding NEVER arrives by webhook. Refusing unconditionally keeps
    // POST /v1/webhooks/funding shut under this processor, so the only way to
    // reach FUNDED is the authenticated, allowlisted ops route.
    return false
  }

  parseEvent(): FundingParseResult {
    // Unreachable in practice (verifySignature refuses first). Classifying as
    // malformed rather than throwing honors the interface contract that parse
    // never throws.
    return { outcome: 'malformed' }
  }

  async voidFunding(): Promise<FundingUndo> {
    return this.undo()
  }

  async refund(): Promise<FundingUndo> {
    return this.undo()
  }

  // Both undo ops resolve identically, and NEITHER may claim success.
  //
  // By the time a manual transfer is FUNDED the money is real and already
  // collected — it is sitting as USDC in the treasury wallet — so there is no
  // uncleared pull to cancel. Returning `status: 'succeeded'` would book a
  // disbursement that never happened and tell the sender they had been made
  // whole. `'pending'` is the truth: the obligation is recorded, and a human
  // returns the funds per docs/runbooks/manual-refund.md, after which the
  // refund_settled / refund_failed tail closes it out.
  //
  // `mode: 'refunded'` (never 'voided') is what makes the ledger correct: funds
  // WERE collected, so the receivable settles on its own clearing leg and cash
  // leaves cash_clearing. undoModeForRef independently reads the same answer off
  // the `manualrefund_` prefix, which is the durable encoding the crash-recovery
  // paths rely on — an unknown prefix already classifies as 'refunded', so the
  // two agree by construction.
  private undo(): FundingUndo {
    return {
      provider: this.provider,
      ref: `manualrefund_${crypto.randomUUID()}`,
      status: 'pending',
      mode: 'refunded',
    }
  }
}
