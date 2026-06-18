---
name: i18n
description: Add or change user-facing strings. Enforces English + Spanish parity and no hardcoded text.
---

Every user-facing string ships in English AND Spanish in the same change. No exceptions.

## Rules
- NO hardcoded user-facing strings in components. Always `t('key')` via react-i18next.
- Add the key to BOTH locale files in the same commit:
  `apps/mobile/locales/en.json` and `apps/mobile/locales/es.json`
- Key naming: `screen.section.element` — e.g. `credit.consent.title`, `remit.confirm.cta`
- Interpolate values, never concatenate: `t('remit.amount', { amount })` not `t('a') + amount`
- Plurals and currency/number formatting go through i18next/Intl, not manual string building

## Consent & legal strings — STRICTER
- FCRA/TILA/consent text is legally operative in BOTH languages. Do NOT machine-translate it.
- Mark such keys with a `// NEEDS LEGAL REVIEW (ES)` note and flag for compliance-reviewer.
- Spanish consent must be as clear and unambiguous as English (ambiguous consent is a compliance finding).

## Checklist before finishing
- [ ] No literal user-facing strings in JSX (run the grep below)
- [ ] Key exists in en.json AND es.json
- [ ] Values interpolated, not concatenated
- [ ] Consent/legal strings flagged for human translation review

## Catch hardcoded strings
```bash
# Flags JSX text nodes that aren't wrapped in t()
grep -rnE '>[A-Za-z]{3,}' apps/mobile/app --include=*.tsx | grep -v 't('
```