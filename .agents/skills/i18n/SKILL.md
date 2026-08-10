---
name: i18n
description: Add or change user-facing strings. Enforces English + Spanish parity and no hardcoded text.
---

Every user-facing string ships in English AND Spanish in the same change. No exceptions.

## Where strings live

`packages/shared/src/i18n/translations.ts` — one typed object, imported by web and mobile via
`@puente/shared/i18n`. There are no locale JSON files and no i18next; the `Translations` type is
what enforces parity, because `translations: Record<Lang, Translations>` will not compile if `en`
and `es` disagree on a single key. That is a stronger guarantee than two JSON files that drift.

## Rules

- NO hardcoded user-facing strings in components. Read them off the context:
  `const { t } = useLanguage()` → `t.send.errors.quote_expired`. It is **object access, not
  `t('key')`** — a missing key is a typecheck failure, not a runtime fallback.
- Add the key to the `Translations` type AND to both the `en` and `es` blocks, in the same commit.
  The type is the forcing function: add it there first and the compiler tells you what's missing.
- Key naming: `namespace.section.element` — e.g. `onboarding.verify.resendIn`, `send.errors.generic`.
- Interpolate in the component, never concatenate inside the string table. Strings with a variable
  part take a function: `(n: number) => \`Reenviar en ${n}s\``.
- Currency and dates go through the helpers in `sendFormat.ts` (`formatUsd`, `formatMxn`), never
  manual string building. On mobile, verify Hermes `Intl` support before relying on
  `toLocaleString` options.

## Strings that do NOT live here

- **Reg E disclosures and receipts** come from the API already bilingual —
  `{ content: { en, es } }` — and are rendered verbatim. Never restate them client-side.
- **The cancel 202** carries its own `messages: { en, es }`. Prefer that copy over any mapped one.

## Consent & legal strings — STRICTER

- FCRA/TILA/TCPA/consent text is legally operative in BOTH languages. Do NOT machine-translate it.
- Mark such keys with a `// NEEDS LEGAL REVIEW (EN + ES)` comment and run `compliance-reviewer`.
- Spanish consent must be as clear and unambiguous as English (ambiguous consent is a finding).
- **`onboarding.signup.smsConsent` is frozen.** It is quoted verbatim in the Twilio campaign's
  `message_flow` field, and the campaign is registered as 2FA only. An earlier version that added
  "and account notices" was rejected by TCR (error 30896). Widening it requires re-registering the
  campaign first. The comment block above it in `translations.ts` is the authority — read it before
  touching that key, and render it unmodified on every surface (no truncation for small screens).

## Checklist before finishing

- [ ] Key added to the `Translations` type, and to both `en` and `es`
- [ ] `pnpm run typecheck` passes (this is what proves parity)
- [ ] Values interpolated in the component, not concatenated in the table
- [ ] Consent/legal strings flagged for human translation review
- [ ] No literal user-facing strings in JSX (grep below)

## Catch hardcoded strings

```bash
grep -rnE '>[A-Za-z]{3,}' apps/mobile/app apps/web/components --include=*.tsx | grep -v 't\.'
```
