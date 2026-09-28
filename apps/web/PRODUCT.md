# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary user: a LATAM immigrant living and working in the U.S. who regularly sends money home
and has thin or no U.S. credit history. Eligible with either an ITIN or an SSN (the product
explicitly supports ITIN filers, not just SSN holders). The MVP corridor is USD → MXN
(sending to Mexico); Mexico is the first market, with other LATAM sending corridors planned
as later expansion, not yet built.

Job to be done: send money home reliably, at a fair (real) exchange rate, without it being a
dead end — have that recurring activity also build a U.S. credit history, in a single app
instead of juggling a remittance app and a separate credit product.

## Product Purpose

Puente is a credit-building remittance app: money movement (USD → MXN) that is also the
mechanism for building U.S. credit history, aimed at newcomers who are otherwise credit
invisible. Success is a sender who trusts the app enough to make it their recurring way of
sending money home, because it costs them nothing extra to also be building credit.

Current build stage: the remittance rail (pure money movement) is the active MVP. Credit
reporting/furnishing is NOT built yet (no furnisher integration exists) — see Capabilities and
Constraints. Lending is a separate, later stack, not part of this MVP.

## Positioning

The single differentiated claim: remittances that already happen every month become the credit
history a newcomer usually can't build any other way, in one app, at the real exchange rate,
for a flat fee — not a separate credit product bolted onto a wallet. Earlier concept work
explored a remittance-backed credit card as the mechanism (see Brand Commitments); that framing
is superseded — the current and durable mechanism is the app itself, not a card.

## Operating Context

- Public marketing/waitlist site (this app) at puentefinancial.com: waitlist capture, a
  self-reported credit-score check (waitlist-field based, not a real bureau pull), and
  financial literacy content.
- Authenticated dashboard (same app, `/dashboard`): onboarding (KYC, e-sign consent, profile),
  recipients, sending a transfer, transfer history, and an internal ops surface for reconciling
  transfers/treasury.
- Bilingual by default: every user-facing string ships in English and Spanish from day one
  (`@puente/shared/i18n`), not as a later localization pass.
- Regulatory posture actively shapes copy: forward-looking claims about credit building are
  legally constrained pending counsel review (UDAAP exposure) — see Capabilities and
  Constraints.

## Capabilities and Constraints

- **Live now:** waitlist, self-reported credit score check (no bureau/CRS integration — do not
  imply a real credit pull), financial literacy content, and the USD→MXN remittance MVP
  (onboarding/KYC, recipients, quotes, send, transfer lifecycle, dashboard).
- **Not built yet:** credit reporting / furnishing to bureaus (no furnisher code exists). Any
  copy claiming "build your credit" today must stay forward-looking ("coming soon"), not
  present-tense fact, until that ships and counsel signs off.
- **Not in scope for this MVP:** a physical or virtual credit card. Lending generally is a
  separate future stack.
- **Corridor:** Mexico only today (USD→MXN via SPEI/CLABE). Multi-corridor LATAM expansion is
  a roadmap intent, not a current capability.
- Money handling follows the monorepo's financial-integrity rules (integer minor units,
  double-entry ledger, explicit FX step, idempotent money-moving endpoints) — see root
  CLAUDE.md; this is enforced in `apps/api`, not this app, but the web dashboard's copy and
  flows must not imply guarantees the ledger/state machine doesn't back.

## Brand Commitments

- Name: **Puente Financial**. "Puente" (Spanish for "bridge") is the core metaphor — bridging
  a remittance sender's existing habit into U.S. credit history.
- Mark: a three-arch stone-bridge silhouette, single-color, `fill-rule="evenodd"`, fixed
  aspect ratio 240×116 — treat as a fixed asset, not something to redraw
  (`public/mark.svg`, `public/design_handoff_brand_assets/`).
- Wordmark: "Puente" in a heavy weight, "Financial" in a lighter/muted weight beside it.
- Typefaces actually shipped in code (source of truth over the older brand-handoff doc, which
  named Hanken Grotesk alone): **Bricolage Grotesque** for display/headings, **Hanken Grotesk**
  for body, **Space Mono** for a monospace accent (`apps/web/app/layout.tsx`).
- Palette in active use (`tailwind.config.ts`, `globals.css`): Navy (`#0F2A4A`), Blue
  (`#1B4B8A`/`#2D6BE4`), Gold/Orange accent (`#F5A623`) on light surfaces; darker navy tones on
  the dark hero band. Treat the brand-handoff README's hex values as close but not
  authoritative where the two disagree — the shipped Tailwind tokens win.
- The `public/design_handoff_brand_assets/README.md` document is **stale evidence, not
  current truth**: it was written for an earlier "remittance-backed credit card" concept and
  its OG copy ("The only card that turns your remittances into credit history") no longer
  matches the live positioning or `layout.tsx` metadata. The mark/logo/favicon assets it
  shipped are still current; its product-framing copy is not.
- Persona voice cue already in use in copy/sample data: Spanish first names (e.g. "María",
  "Rosa Santos", "Miguel Ángel") for illustrative dashboard content — keep sample data
  culturally consistent with the target audience.

## Evidence on Hand

A waitlist and a live pilot exist; no specific current signup count or pilot-send count is
recorded here — ask before citing a number, rather than reusing a prior snapshot.

## Product Principles

1. The remittance is the product; credit-building is what makes it worth switching to, not a
   bolted-on feature — never let visual or copy work imply a credit product that overshadows
   the money-movement core.
2. Say only what's actually live. Copy about credit reporting stays future-tense until the
   furnisher integration and counsel review are both done; this is a compliance constraint, not
   a style preference.
3. Bilingual is baseline, not an add-on — Spanish is never a lesser/secondary treatment of
   English copy.
4. Design for someone who may be credit-invisible, may file with an ITIN, and may be new to
   U.S. financial products — clarity and trust cues outrank density or cleverness.
5. Mexico is today's corridor, not the ceiling of the product's ambition — avoid hard-coding
   "Mexico" into positioning language where "LATAM" is the truthful, durable claim.
