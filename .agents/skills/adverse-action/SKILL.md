---
name: adverse-action
description: Scaffold the ECOA/FCRA adverse action notice whenever a credit decision is negative
---

Invoke this skill any time the API returns a credit denial, counter-offer, or incomplete-application response.

## What triggers an adverse action notice
- Credit application denied
- Credit limit lower than requested
- Terms offered are materially worse than applied for
- Application marked incomplete and closed

## Legal requirements
**ECOA (15 U.S.C. § 1691):** Notice must be provided within **30 days** of the decision.
**FCRA (15 U.S.C. § 1681m):** If a consumer report was used, the notice must also include the CRA's name, address, and phone number, and state the consumer's right to a free report within 60 days.

## Notice shape
```ts
interface AdverseActionNotice {
  userId: string
  decisionAt: string         // ISO timestamp of the credit decision
  noticeDeadline: string     // decisionAt + 30 days — store and alert if not sent by then
  actionTaken:
    | 'denied'
    | 'counter_offer'
    | 'incomplete_application'
  reasons: AdverseActionReason[]  // 1–4 reasons, ordered by significance
  creditBureauUsed: CreditBureauInfo | null
}

interface AdverseActionReason {
  code: string    // standard FCRA reason codes (see below)
  text: string    // human-readable, translated via i18next
}

interface CreditBureauInfo {
  name: string
  address: string
  phone: string
}
```

## Standard reason codes (use these, not custom strings)
```
01 — Insufficient credit history
02 — Delinquent past or present credit obligations
08 — Too many inquiries in the last 12 months
14 — Length of time accounts established
18 — Number of accounts with delinquency
22 — Amount owed on revolving accounts too high
40 — Unable to verify identity
```

## API response structure
Any route returning a credit denial MUST include the notice inline:
```ts
return reply.status(200).send({
  decision: 'denied',
  adverseAction: {
    reasons: [
      { code: '01', text: t('credit.adverseAction.insufficientHistory') },
    ],
    creditBureauUsed: {
      name: 'CRS Credit',
      address: '...',
      phone: '...',
    },
    noticeDeadline: addDays(new Date(), 30).toISOString(),
  },
})
```

## Required tests
```ts
it('denial response includes adverse action notice', async () => {
  const res = await app.inject({ method: 'POST', url: '/v1/credit/apply', ... })
  expect(res.json().adverseAction).toBeDefined()
  expect(res.json().adverseAction.reasons.length).toBeGreaterThanOrEqual(1)
  expect(res.json().adverseAction.reasons.length).toBeLessThanOrEqual(4)
  expect(res.json().adverseAction.noticeDeadline).toBeDefined()
})

it('adverse action reasons use standard FCRA codes', async () => {
  const VALID_CODES = ['01','02','08','14','18','22','40']
  const reasons = res.json().adverseAction.reasons
  reasons.forEach(r => expect(VALID_CODES).toContain(r.code))
})
```

## Checklist
- [ ] `adverseAction` object present on every denied/counter-offer response
- [ ] 1–4 reasons, standard FCRA codes only
- [ ] `noticeDeadline` = decision time + 30 days, stored in DB
- [ ] `creditBureauUsed` populated if a consumer report was pulled
- [ ] Reason text goes through i18next (English + Spanish)
- [ ] Audit log entry records the adverse action
- [ ] Run compliance-reviewer subagent before merging
