# KYC at first send — the K lane (K1–K8)

**Ratified:** 2026-08-27 (grilled Q1–Q8) · **K6 custody clause invoked:** 2026-09-02 ·
**Build complete K1–K6:** 2026-09-03 · **Status:** built, behind a flag, awaiting the K7 cutover

## Context

Onboarding used to end with Bridge's hosted KYC (Persona): a sender created an account, was
redirected off our site to verify, and only then reached a dashboard. That shipped and ran in
production from 2026-07-08 ([`../prds/user-onboarding.md`](../prds/user-onboarding.md)), and it has
two problems the remittance product cannot carry. A sender who has not yet decided to send anything
is asked for a Social Security number by a company they just met, and the one moment they *are*
motivated — money in hand, recipient chosen — is the moment we hand them to a third party.

The K lane moves verification to **first send**, in **our own UI**, using Stripe's crypto-onramp
embedded components (private preview; the account is gated in). Onboarding drops to information and
consents. Bridge still needs a verified customer of its own to move the money, so the sender's DOB
and tax ID are **relayed** to Bridge once, in memory, and never stored.

## Slice map

| Slice | Scope | State |
|---|---|---|
| **K1** | Consent foundation — `consents` table + trigger, two-checkbox consent page, versioned placeholder docs, router requires consents | merged #248 |
| **K2** | Profile expansion — address step (EN+ES), `users` migration, `/continue` drops its KYC branch behind the flag | merged #249 |
| **K3** | Link OAuth + crypto client (server) — `services/stripe-crypto.ts`, LinkAuthIntent create/reuse, token exchange + encrypted storage | merged #250 |
| **K4** | Server send surface — treasury wallet registration, headless session create, checkout endpoint. **New session per attempt, never resume** | merged #251 |
| **K5** | Web send UI — the pure state machine (`apps/web/lib/cryptoPayStep.ts`), the component tree, the BFF proxies | merged #265 |
| **K6a** | The relay (API) — Bridge identity create, ToS leg, `sender_kyc_pending` hold, `kyc_verifications`, `transfers.funding_processor` | merged #273 |
| **K6b** | The relay (web) — ToS-first gate, DOB/tax-ID relay, bounded Bridge poll, Persona fallback, AddressElement | merged #274 |
| **K7a** | Pre-flip hardening — `users` UPDATE policy, OTP verify cap, E.164 boundary, pre-submit refunds, confirm-response secret, PostHog phone, bureau copy | merged #276 |
| **K7b** | **Cutover & sunset** — flip `web-kyc-at-first-send`, swap in counsel-reviewed TOS/Privacy, migrate existing users, retire the widget pay step + onboarding KYC screens | **not started** |
| **K8** | Mobile arm — RN `useOnramp`, seamless sign-in (mobile-only), consent + address screens, app attestation | frozen until K7b is proven |

K6 was deliberately **not** a K7 dependency: the Persona fallback decoupled the cutover from
Bridge's timeline, so the flip was never hostage to a vendor conversation.

## The as-built flow

Sequence diagram, gate ordering, and every non-happy branch: [`../flows.md`](../flows.md) §1d.
Routes: [`../api-contract.md`](../api-contract.md). Tables: [`../erd.md`](../erd.md)
(`consents`, `kyc_verifications`, `stripe_link_tokens`, the `users` KYC columns).

## The decisions that constrain future work

Full text, dated, in [`../decisions.md`](../decisions.md) — the 2026-08-27 through 2026-09-03
entries. The ones most likely to be broken by accident:

- **The custody line.** Address is stored. DOB and the tax ID are relayed and never persisted or
  logged; `apps/api/src/routes/schema-pii.test.ts` scans every migration to keep it that way. On
  the Stripe leg those values go client→SDK and never touch us at all. The relay exists because
  Bridge's Customers API requires the tax ID (`missing.all_of`) and offers no way to accept a
  verification done elsewhere — probed 2026-09-02, including their `kyc_links` endpoint, which is
  another way to *collect*, not a way to accept.
- **Stripe markup is never configured.** It is account-level and sticky. All margin rides on
  Bridge's per-transfer `developer_fee_percent`, which is freely changeable.
- **Stripe sessions are never resumed.** No cancel API and buggy resumption; a new session per
  attempt, and the transfer draft is what persists.
- **Crypto-ness is de-emphasized, never denied.** The Link modal, the OAuth consent screen, and
  Stripe's own emails leak it unavoidably, so the pay step sets expectations in one sentence
  (EN+ES) rather than pretending.
- **ToS before Link auth.** Bridge's `signed_agreement_id` is single-use and must exist before the
  customer is created.
- **A duplicate tax ID is a hard stop**, not a retry — the collision is a real person.

## What K7b still owes

Human-shaped, and none of it is code:

- Counsel-reviewed TOS + Privacy to replace the K1 placeholders (**the hard gate**), plus sign-off
  on the reworded credit-building copy (K7a) and the provider-disclosure language.
- Counsel on Reg E availability versus the `sender_kyc_pending` hold, and on whether Bridge's
  service-provider paper covers the relay.
- Stripe in writing on ITIN acceptance (their email and their public docs disagree) and the fee
  schedule. ITIN is core-demographic risk, not an edge case.
- Bridge on the `rejection_reasons` vocabulary, the duplicate shape, whether a failed create burns
  the agreement, and whether customer-level `approved` implies the `spei` endorsement (#192).
- Production platform keys in Doppler, held until the flip by design.
- Supabase PITR before widening past the trusted cohort (#219).

## What the sandbox cannot prove

Bridge auto-approves the canonical sandbox identity in seconds, so the drives on 2026-09-03 covered
the happy path, an already-approved sender, a legacy customer with no ToS row, and the reload edge.
**Rejection, Persona, manual review, duplicate identity, and the poll timeout have never executed.**
They are pilot-verification items and want three real cohorts: an SSN holder, an ITIN holder, and a
thin-file sender.
