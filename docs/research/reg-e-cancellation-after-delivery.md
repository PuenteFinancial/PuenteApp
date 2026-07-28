# Research memo — Is a timely §1005.34 cancel still owed a refund if the payout delivers anyway?

**Date:** 2026-07-28 · **Status:** research for the PR7 counsel package — **not legal advice, not
adopted policy**. The implemented behavior (slice-7 PR6b) follows the conservative reading below;
counsel confirms or corrects it.

## Question presented

A sender requests cancellation **within 30 minutes of payment**, while the funds are **not yet
picked up or deposited** (our `SUBMITTED`/`IN_FLIGHT` 202). Before we can stop it, the payout
**completes**. Do we still owe the full refund?

Why it matters here specifically: SPEI deposits settle in seconds, so a timely cancel racing a
deposit is not an edge case for us — it is the expected shape of a post-submission cancel. And the
repo briefly held both answers at once: [transfer-state-machine.md](../transfer-state-machine.md)
said refund; [runbooks/payout-holds.md](../runbooks/payout-holds.md) step 4 said the right
"extinguished at deposit" (corrected 2026-07-28).

## What we implemented (PR6b)

Timeliness is evaluated **once, at the moment the request is received** (`within_window`, computed
inside the recording RPC against `cancelable_until`, then frozen). A timely request whose payout
completes anyway routes `COMPLETED → UNDER_REVIEW` and a human pays a **correction payment** — the
accepted, bounded double-pay. Denial is lawful only for an untimely request.

## The regulation

[12 CFR 1005.34](https://www.consumerfinance.gov/rules-policy/regulations/1005/34/):

- **(a)** — the provider must comply "with respect to any oral or written request to cancel …
  **received by the provider no later than 30 minutes after the sender makes payment**," provided
  the request identifies the transfer and "**the transferred funds have not been picked up** by the
  designated recipient **or deposited** into an account of the designated recipient."
- **(b)** — the provider "shall refund … the **total amount of funds provided by the sender** …
  including any fees and, to the extent not prohibited by law, taxes … **within three business days
  of receiving a sender's request to cancel**."

Two textual points favor request-time evaluation:

1. The picked-up/deposited condition sits inside the description of **which requests** the section
   applies to, in the present perfect ("have not been picked up") — i.e., a property of the moment
   the request is received, alongside the 30-minute receipt condition.
2. (b) keys the refund off **the request**, with no carve-out for "unless the transfer subsequently
   completes."

The [official commentary](https://www.consumerfinance.gov/rules-policy/regulations/1005/interp-34/)
is **silent on this exact race** — it never says when the condition is evaluated or what happens if
the payout completes after a valid request. But comment 34(b) is categorical in the same direction:
*"If a sender provides a **timely** request to cancel a remittance transfer, a remittance transfer
provider **must** refund all funds provided by the sender."* Validity/timeliness is a property of the
request; the refund duty follows from it.

CFPB consumer guidance
([What is a remittance transfer and what are my rights?](https://www.consumerfinance.gov/ask-cfpb/what-is-a-remittance-transfer-and-what-are-my-rights-en-1161/),
[money-transfer FAQ](https://www.consumerfinance.gov/consumer-tools/money-transfers-revisions-sept-2023/money-transfer-frequently-asked-questions/))
phrases it as: you have up to 30 minutes to cancel "unless the transfer has **already** been picked
up or deposited" — "already" relative to the cancellation, not to the provider's later processing.

## Competitor terms

### Remitly — the on-point authority (read verbatim from the US User Agreement PDF)

[Remitly US User Agreement](https://www.remitly.com/pdf/en/us/476c6e48-9362-4046-98ab-f80969329243),
effective 2026-02-23, §12.3 *Cancellations*:

> "You can attempt to cancel your transaction at any time prior to its completion. **Completion of
> your Transaction means that your recipient has picked up the funds you sent for cash pick-up or
> the funds have been deposited into the Recipient's bank account at the time of your cancellation
> request.** Upon receipt of a cancellation request, we will confirm whether the transaction has
> been completed … prior to initiating a refund. … The Transaction Amount will not be refunded after
> the Completion of the Transaction."

The largest US-headquartered digital remitter **contractually defines completion as of the moment of
the cancellation request**. Under their own definition, a deposit landing *after* a timely request is
not "Completion," so their no-refund-after-completion carve-out does not reach our scenario — in our
exact race, Remitly's contract commits them to the refund too.

Their §13 Texas provision points the same way: cancel within 30 minutes for an immediate full refund
"**unless the intended recipient of the transaction has received the funds**" — received, not
"receives before we process your request."

Caveat: a contract definition tells us Remitly's *legal posture*, not their operational practice on a
seconds-later deposit; the latter is unobservable from outside.

### Not obtained (fetch-blocked; listed for counsel rather than paraphrased from snippets)

- **Xe** US Error Resolution and Cancellation Disclosure — 403.
  [help.xe.com article](https://help.xe.com/hc/articles/4403064056209-US-Error-Resolution-and-Cancellation-Disclosure)
- **Wise / Western Union / Xoom / MoneyGram** US terms — not fetched verbatim this pass. Their
  receipts all carry the CFPB model-form line ("You can cancel for a full refund within 30 minutes of
  payment, unless the funds have been picked up or deposited"), which carries the same ambiguity as
  the reg itself.

## The steelman for the other side

One could argue the (a) condition must also hold when the provider *acts*, so a deposit landing
between request and processing defeats the right. Nothing found supports it: no commentary, no CFPB
guidance, and the one major-competitor contract obtained defines the moment **against** that reading.
Its practical effect would also be perverse — the faster a provider's rail, the emptier the statutory
right, since any provider could "process" slowly enough for the deposit to win. It remains a
*colorable* reading of ambiguous text, which is why this stays counsel-gated.

## For counsel (PR7)

1. Confirm request-time evaluation of §1005.34(a), i.e. that the implemented `COMPLETED` tail
   (correction payment on a timely request) is required — or at minimum defensible — rather than
   voluntary.
2. Confirm the denial evidence standard for untimely requests: our own `cancelable_until` versus
   Bridge's deposit timestamp, and which needs to be preserved.
3. Review the 202 body copy and the `underReview`/banner strings (already staged for the package).
4. Obtain Wise/WU/Xoom terms through channels that aren't bot-blocked, if more triangulation is
   wanted.
