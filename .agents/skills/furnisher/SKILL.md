---
name: furnisher
description: Metro 2 credit reporting field mapping and §623 dispute investigation flow
---

Invoke this skill when implementing any code that reports account data to a credit bureau, or that handles a consumer dispute about reported data.

## You are a furnisher
Under FCRA §623, Puente is a "furnisher of information." This means:
- You must report accurately — errors are legal liability
- You must investigate disputes within **30 days** (45 if consumer provides additional info)
- You must notify the CRA of corrections
- You cannot report a disputed item without noting it is disputed

## Metro 2 — key fields
Metro 2 is the standard data format all major bureaus accept. These are the fields you will always populate:

```ts
interface Metro2Record {
  // Segment identifier
  recordDescriptorWord: 'HEADER' | 'BASE' | 'TRAILER'

  // Account identification
  accountNumber: string           // your internal account ID, max 30 chars
  portfolioType: 'I'              // I=Installment, R=Revolving, O=Open, M=Mortgage
  accountType: string             // e.g. '18' = credit builder loan

  // Consumer identification (PII — never logged)
  ssn: string                     // 9 digits, no dashes
  dateOfBirth: string             // MMDDYYYY
  firstName: string
  lastName: string
  address: string

  // Account status (most critical for score impact)
  paymentStatus: PaymentStatusCode
  accountStatus: AccountStatusCode
  currentBalance: number          // minor units
  highCredit: number              // highest balance ever, minor units
  creditLimit: number             // minor units
  amountPastDue: number           // 0 if current

  // Dates (MMDDYYYY format)
  dateOpened: string
  dateOfFirstDelinquency: string | null
  dateOfLastPayment: string
  dateReported: string            // always today
}

type PaymentStatusCode =
  | '00'  // Current — paid as agreed
  | '11'  // 30 days past due
  | '12'  // 60 days past due
  | '13'  // 90 days past due
  | '71'  // Account in collections
  | '97'  // Unpaid balance reported as loss

type AccountStatusCode =
  | '11'  // Open
  | '13'  // Paid, closed by consumer
  | '62'  // Paid in full, was a charge-off
  | '78'  // Derogatory
  | '97'  // Unpaid balance
```

## Reporting cadence
Report monthly, on a consistent date. Late or skipped reports can harm consumers' scores and create compliance exposure.

```ts
// apps/api/src/services/creditReporting.ts
export async function buildMonthlyReport(db: SupabaseClient): Promise<Metro2Record[]> {
  // Query all active accounts, map to Metro2Record[]
  // NEVER call from client — server-side only
}
```

## §623 Dispute investigation flow

When a consumer disputes information you reported:

```
Consumer → CRA → You (furnisher) receive e-OSCAR dispute notice
                    ↓
           Investigate within 30 days
                    ↓
        ┌── Accurate ──→ Verify to CRA, no change
        └── Inaccurate → Correct in your DB → Notify CRA of correction
                    ↓
           Notify consumer of outcome
```

```ts
interface DisputeInvestigation {
  id: string
  consumerId: string
  accountNumber: string
  receivedAt: string
  deadline: string          // receivedAt + 30 days (or 45 if extended)
  status: 'open' | 'verified_accurate' | 'corrected' | 'deleted'
  craNotifiedAt: string | null
  consumerNotifiedAt: string | null
  resolution: string | null
}
```

## Required tests
```ts
it('Metro 2 record has no null required fields', () => {
  const record = buildMetro2Record(account)
  expect(record.accountNumber).toBeTruthy()
  expect(record.paymentStatus).toMatch(/^\d{2}$/)
  expect(record.dateReported).toMatch(/^\d{8}$/)
})

it('dispute deadline is within 30 days of receipt', () => {
  const dispute = openDispute({ receivedAt: '2026-01-01T00:00:00Z' })
  const deadline = new Date(dispute.deadline)
  const received = new Date(dispute.receivedAt)
  expect((deadline.getTime() - received.getTime()) / 86400000).toBeLessThanOrEqual(30)
})
```

## Checklist
- [ ] All Metro 2 required fields populated before submission
- [ ] `dateReported` = today, not hardcoded
- [ ] PII fields (SSN, DOB) never logged — pass through without touching logs
- [ ] Dispute deadlines tracked in DB with alerting if approaching
- [ ] CRA notification recorded in audit log
- [ ] Run security-reviewer and compliance-reviewer before merging
