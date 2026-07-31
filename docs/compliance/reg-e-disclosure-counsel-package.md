# Reg E disclosure wording — counsel review package

**Date:** 2026-07-29 · **Status:** ⚠️ awaiting counsel sign-off + human Spanish review
**Prepared for:** outside counsel (EFTA / Reg E subpart B) · human ES reviewer
**Code state:** every change below is staged on branch `feat/slice-7-pr7-reg-e-counsel-package`
(disclosure content version 1 → 2) and is **merge-gated on this review**. Wording is stored as
data, so counsel edits are copy swaps, not engineering work.

---

## 1. What we are asking for

1. **Sign-off (or edits) on the reconciled wording** in §4 — six changes, each shown as
   current → proposed → statutory basis.
2. **Human Spanish review** of every string listed in §6. All current Spanish is
   machine-drafted. The pilot sender is the founder only; no real user sees this copy before
   this review completes.
3. **Answers to the four open questions** in §7 — two of them (support telephone number, the
   state-regulator/CFPB block) are required receipt content we cannot draft without
   counsel/provisioning input. They are scheduled as a follow-up copy version (v3), so v2
   sign-off need not wait on them.

## 2. Product context (what renders where)

Puente is a USD → MXN remittance product (SPEI bank deposit). Funding is US ACH debit; payout is
executed by Bridge (our licensed partner) from a pre-funded treasury wallet; delivery is
typically seconds after submission. One transfer = one fixed MXN amount disclosed up front; the
recipient receives exactly the disclosed amount (no third-party deductions on the SPEI leg).

Four artifacts carry legally-operative or rights-adjacent copy:

| Artifact | When the sender sees it | Source of copy |
|---|---|---|
| **Prepayment disclosure** (§1005.31(b)(1)) | Review screen, before confirming payment | `apps/api/src/services/disclosures.ts` (`renderEn`/`renderEs`), stored immutably per transfer |
| **Receipt** (§1005.31(b)(2)) | Receipt view, after delivery | same file (`buildReceiptDisclosure`), written once at COMPLETED |
| **Transfer tracker strings** | Live status page (steps, cancel window, outcomes) | `apps/web/lib/translations.ts` (`send.track`) |
| **Post-submission cancel response** ("the 202") | When a cancel request arrives after the payout already left | `apps/api/src/routes/v1/transfers.ts` |

Both language renderings are generated and stored together for every transfer; the sender's
locale picks which one displays, and either is retrievable afterward.

## 3. Current copy, verbatim (v1)

### 3.1 Prepayment disclosure — English

> **Prepayment disclosure**
> Transfer amount: $198.01 · Transfer fee: $1.99 · Total to pay: $200.00 · Amount to be received: $3,960.14 MXN
> Exchange rate: 1 USD = 19.9997 MXN
> *(amounts illustrative; rate rendered at 4 decimal places per §1005.31(b)(1)(iv))*
>
> You have the right to cancel this transfer and receive a full refund for 30 minutes after you
> pay, unless the funds have already been **submitted for payout**. To cancel, contact us at the
> address below.
>
> You have the right to dispute errors in this transfer. If you think there is an error, contact
> us within 180 days of the **promised delivery date**. You may also contact the Consumer
> Financial Protection Bureau (consumerfinance.gov).
>
> Make sure the recipient account number (CLABE) is correct. If you provide an incorrect account
> number and the transfer is deposited into the wrong account, you may lose the transfer amount.
>
> Puente Financial — support@puentefinancial.com

### 3.2 Prepayment disclosure — Spanish

> **Divulgación previa al pago**
> Monto de la transferencia: $198.01 USD · Comisión por transferencia: $1.99 USD · Total a pagar:
> $200.00 USD · Monto a recibir: $3,960.14 MXN
> Tipo de cambio: 1 USD = 19.9997 MXN
>
> Tiene derecho a cancelar esta transferencia y recibir un reembolso completo durante los 30
> minutos posteriores al pago, salvo que los fondos ya hayan sido **enviados para su entrega**.
> Para cancelar, contáctenos en la dirección indicada abajo.
>
> Tiene derecho a disputar errores en esta transferencia. Si cree que hay un error, contáctenos
> dentro de los 180 días posteriores a la **fecha de entrega prometida**. También puede contactar
> al Consumer Financial Protection Bureau (consumerfinance.gov).
>
> Verifique que el número de cuenta del destinatario (CLABE) sea correcto. Si proporciona un
> número de cuenta incorrecto y la transferencia se deposita en la cuenta equivocada, podría
> perder el monto transferido.
>
> Puente Financial — support@puentefinancial.com

### 3.3 Receipt (v1)

The v1 receipt **reuses the prepayment content verbatim** (same numbers — accurate, since the
delivered MXN amount equals the disclosed amount — and the same rights/contact copy). It carries
no receipt title, no date of availability, no recipient name, no telephone, no regulator block.
§4.2 and §7 address this.

### 3.4 Tracker strings (English; Spanish mirrors)

- Status steps: *Waiting for payment → Payment received → **Sent for payout** → On its way → Delivered*
- Cancel window: *"You have {time} left to cancel this transfer."* + note: *"If it's already been
  sent for payout, cancelling isn't automatic — contact us and we'll take it from there."*
- Outcome — Canceled: *"This transfer was canceled. Your refund is being returned now."*
- Outcome — Refunded: *"This transfer was canceled and you were refunded in full."*
- Outcome — Payment failed: *"We couldn't collect your payment, so nothing was sent and **you
  were not charged**. Start a new transfer to try again."*
- Outcome — Couldn't be delivered: *"Your recipient's bank couldn't accept this transfer. You
  will be refunded in full — contact support if you have questions."*
- Outcome — Payment reversed: *"Your bank reversed the payment for this transfer. Contact
  support so we can sort it out with you."*
- Outcome — Working on your cancellation: *"Your transfer was delivered, and you asked to cancel
  it. We're reviewing your request — this page will update when it's resolved."*

### 3.5 The 202 (post-submission cancel) — both languages

> EN: "This transfer is already on its way to your recipient, so it can't be stopped
> automatically. We've recorded your cancellation request. If you asked within 30 minutes of
> paying and before the money was delivered, you'll get a full refund. This page will update when
> it's resolved."
>
> ES: "Esta transferencia ya va camino a tu destinatario, así que no se puede detener
> automáticamente. Registramos tu solicitud de cancelación. Si la hiciste dentro de los 30
> minutos después de pagar y antes de que se entregara el dinero, recibirás un reembolso
> completo. Esta página se actualizará cuando se resuelva."

*(Substance reviewed internally 2026-07-28 against §1005.34's two conditions; included here for
completeness and register review, not re-drafted.)*

## 4. Proposed changes (staged as v2)

### 4.1 Cancellation rights — the extinguishing event

- **Current:** "…unless the funds have already been **submitted for payout**."
- **Proposed (EN):** "…unless the funds have already been **picked up by your recipient or
  deposited into your recipient's account**."
- **Proposed (ES):** "…salvo que los fondos ya hayan sido **retirados por el destinatario o
  depositados en la cuenta del destinatario**."
- **Basis:** §1005.34(a)(2) conditions the right on funds not "picked up by the designated
  recipient or deposited into an account of the designated recipient." There is no
  "submitted-to-partner" exception (CFPB official interpretations reviewed 2026-07-20; recorded
  in our decisions log). The v1 wording states a *stricter* rule than the law allows — our
  operational handling already honors the statutory rule; the disclosure must match it.

### 4.2 Receipt identity — date available + recipient name + title

- **Current:** receipt = prepayment content verbatim.
- **Proposed:** the receipt rendering adds, in both languages:
  - Title: **"Receipt" / "Recibo"**;
  - **"Date available: {date}" / "Fecha de disponibilidad: {date}"** — the delivery date,
    formatted in the America/Mexico_City calendar day (§1005.31(b)(2)(ii): "the date in the
    foreign country on which funds will be available"). Sourced from the transfer's write-once
    first-completion timestamp — i.e. actual delivery, which for SPEI is the same day the sender
    pays — and immune to the post-delivery review round trip, which would otherwise re-stamp a
    later date;
  - **"Recipient: {first} {last}" / "Destinatario: {first} {last}"** (§1005.31(b)(2)(iii)).
- **Basis:** §1005.31(b)(2) requires the receipt to contain the (b)(1) disclosures **plus**
  items (ii)–(vii); v1 satisfies only (i) and (iv). Items (v) and (vi) remain open — see §7.

### 4.3 Error-resolution statement — the 180-day anchor

- **Current:** "…within 180 days of the promised delivery date."
- **Proposed (EN):** "…within 180 days of the date we promised the funds would be available to
  your recipient."
- **Proposed (ES):** "…dentro de los 180 días posteriores a la fecha en que prometimos que los
  fondos estarían disponibles para su destinatario."
- **Basis:** §1005.33(b) keys the notice period to the **disclosed date of availability**;
  "promised delivery date" is close but not the regulation's term, and with 4.2 the receipt now
  states that date explicitly, so the statement can reference it precisely.

### 4.4 Provider contact line

- **Current:** "Puente Financial — support@puentefinancial.com"
- **Proposed:** "Puente Financial · support@puentefinancial.com · puentefinancial.com"
- **Basis:** §1005.31(b)(2)(v) requires "name, telephone number(s), and Web site" on the
  receipt. This change adds the website; **the telephone number is missing and is a provisioning
  item** (§7, Q1). Email is retained as additional information.

### 4.5 Tracker step label + cancel-window note

- **Current:** SUBMITTED renders as **"Sent for payout" / "Enviada para su pago"**; the note
  under the cancel countdown reads "If it's already been sent for payout, cancelling isn't
  automatic — contact us and we'll take it from there."
- **Proposed:** step label **"Sending" / "Enviando"**; note **"Once we start sending it,
  cancelling isn't automatic — contact us and we'll take it from there." / "Una vez que
  comenzamos a enviarla, la cancelación no es automática — comunícate con nosotros y lo
  resolvemos."**
- **Basis:** consistency with 4.1 — the old label teaches senders that submission is the moment
  the cancellation right dies, which is exactly the misstatement being corrected in the
  disclosure, and the note sits directly under the sender's most-read statement of the rule. The
  new note states the *mechanism* (self-service ends when sending starts; support takes over),
  not the legal rule, which the disclosure states correctly. (Product copy, not a §1005.31
  disclosure — changed for consistency, flagged for the same review.)

### 4.6 Outcome copy accuracy (product copy, truthfulness fixes)

- **Payment failed** — v1 asserts "you were not charged." The PAYMENT_FAILED state is also
  reached on webhook *silence* (a 30-minute reconciliation timeout), which is evidence of
  abandonment, not proof of no charge.
  **Proposed (EN):** "We couldn't confirm your payment, so this transfer was not sent. If your
  bank shows a charge for it, contact us at support@puentefinancial.com and we'll make it right.
  Start a new transfer to try again."
- **Canceled** — v1: "Your refund is being returned now."
  **Proposed (EN):** "This transfer was canceled. Your full refund, including the fee, has been
  issued — depending on your bank, it can take a few business days to appear."
- **Refunded** — v1 asserts the money is back ("you were refunded in full") and assumes the
  cancel path, but the state is also reached from payout-failure and review-resolution paths.
  **Proposed (EN):** "Your full refund for this transfer, including the fee, has been issued.
  Depending on your bank, it can take a few business days to appear."
- **Couldn't be delivered** — v1 promises "You will be refunded in full" unconditionally, while
  refund execution on a failed payout currently awaits an operator (the automatic path ships
  disabled by default); it also omits the fee.
  **Proposed (EN):** "Your recipient's bank couldn't accept this transfer, so nothing was
  delivered. You'll receive a full refund, including the fee — this page will update when it's
  been issued. Contact support if you have questions." (States the entitlement without asserting
  execution status; the page flips to the Refunded outcome when it actually issues.)
- **Basis:** accuracy (a statement of fact the system cannot verify is a UDAAP exposure);
  §1005.34(b) frames the duty as refunding the **total amount including fees** — the new copy
  says so explicitly. Spanish mirrors staged for each.

## 5. Register question (usted / tú) — recommendation attached

The legally-operative disclosure/receipt use **usted**; the product chrome (tracker, outcomes,
the 202) uses **tú**. A sender can see both registers around one screen. Our recommendation:
**keep the split** — usted for the §1005.31 documents (matching the register of the CFPB's
Spanish model forms and standard Mexican banking practice for contractual text), tú for product
voice. Alternative if the ES reviewer prefers: unify everything on one register. We ask the ES
reviewer to rule; no code assumption depends on the choice.

## 6. Strings needing human Spanish review (complete list)

1. Prepayment/receipt disclosure, all fields (§3.2 + staged v2 changes in §4.1–4.4).
2. Receipt additions: "Recibo", "Fecha de disponibilidad: {date}", "Destinatario: {nombre}".
3. Tracker: all `send.track` strings — steps (incl. "Enviando"), `cancelWindow`,
   `cancelWindowNote`, cancellation-requested banner, all outcome bodies (incl. the three
   staged rewrites in §4.6).
4. The 202 response (§3.5).
5. Error strings surfaced on the send flow (`send.errors.*` in `apps/web/lib/translations.ts`).

## 7. Open questions for counsel

1. **Support telephone number (blocking receipt compliance).** §1005.31(b)(2)(v) requires the
   provider's telephone number(s) on the receipt. We have none provisioned (email + website
   only). Ask: confirm a monitored support number is required before any non-founder sender, and
   whether a VoIP number with voicemail-to-email satisfies "telephone number" for a
   digital-only provider. *(Provisioning pairs with the already-flagged support@ mailbox item.)*
2. **State-regulator + CFPB block (§1005.31(b)(2)(vi)).** The receipt must name the state agency
   "that licenses or charters the remittance transfer provider" plus CFPB contact details. Under
   our program structure — Bridge holds the money-transmission licenses; Puente is the
   consumer-facing brand — **which entity's licensing agency is named, and how should the
   provider be identified** on this line? This interacts with the in-progress MTL papering.
   We will stage this block verbatim once counsel supplies it (copy version 3).
3. **§1005.31(b)(1)(viii) statement on non-covered third-party fees/taxes.** Bridge fixes the
   MXN destination amount and SPEI deposits carry no recipient-bank fee in the normal case, so
   v1/v2 omit the "recipient may receive less…" statement. Ask: is omission correct for our fee
   structure, or should the model-form statement appear regardless?
4. **Error-resolution process adoption.** Our error-resolution ops process exists as an
   unadopted proposal (`docs/runbooks/proposals/error-resolution.md`); the UNDER_REVIEW
   resolution mechanics are built and gated on its adoption. Ask: review + adopt, so the
   statutory clocks and the disclosure's error-resolution statement rest on an approved process.
5. *(Flagged for a later review round, not v2/v3):* when Stripe ACH funding replaces the current
   mechanism, a cancellation inside the 30-minute window will usually **void the debit before
   any money moves** (ACH PaymentIntents are cancelable while processing). Outcome copy for
   "canceled → you were never charged" will be drafted with that change and brought back here.

## 8. What merges when

- **v2 (this branch), on counsel sign-off + ES review:** everything in §4; disclosure content
  version bumps 1 → 2. Historical disclosures/receipts are immutable records of what was
  actually presented and are not rewritten. One data-handling note for completeness: v2 receipts
  denormalize the recipient's name into that append-only store (per (b)(2)(iii)); this is a new
  immutable PII copy retained under Reg E's record-retention duty — flagged so retention/erasure
  policy can account for it.
- **v3 (data-only follow-up):** receipt telephone line (Q1) + regulator/CFPB block (Q2) +
  any (viii) statement (Q3), once inputs exist.
- Cite-check note: statutory quotations above were verified against the CFPB's published
  regulation text (consumerfinance.gov/rules-policy/regulations/1005) on 2026-07-29.
