---
name: ledger
description: Scaffold double-entry ledger posts for any route that moves money
---

Invoke this skill whenever implementing a route that moves funds: remittance sends, credit-line draws, repayments, fee postings.

## Core invariant
Every transaction must balance: **sum of all CREDIT entries = sum of all DEBIT entries** (in minor units, same currency). Any code path that can produce an unbalanced transaction is a bug. Write a test that asserts this before the route ships.

## Entry shape (server-side, apps/api only)
```ts
type EntryType = 'DEBIT' | 'CREDIT'

interface LedgerEntry {
  id: string
  transactionId: string     // groups the paired entries
  accountId: string
  type: EntryType
  amountMinor: number       // always positive integer
  currency: string          // ISO 4217
  description: string
  idempotencyKey: string    // ties back to the originating API request
  createdAt: string
}
```

## Posting a balanced transaction
```ts
async function postTransaction(
  db: SupabaseClient,
  entries: Omit<LedgerEntry, 'id' | 'createdAt'>[],
): Promise<void> {
  const debits = entries.filter(e => e.type === 'DEBIT').reduce((s, e) => s + e.amountMinor, 0)
  const credits = entries.filter(e => e.type === 'CREDIT').reduce((s, e) => s + e.amountMinor, 0)
  if (debits !== credits) throw new Error(`Unbalanced transaction: debits=${debits} credits=${credits}`)

  const { error } = await db.from('ledger_entries').insert(entries)
  if (error) throw error
}
```

## Credit-line draw (linked pair)
When a user draws from their credit line, post two entries under the same `transactionId`:

```ts
const txId = crypto.randomUUID()
await postTransaction(db, [
  // User's liability increases — they owe more
  { transactionId: txId, accountId: userId, type: 'DEBIT',  amountMinor: amount, currency, description: 'Credit line draw', idempotencyKey },
  // Funding source decreases — cash leaves the credit pool
  { transactionId: txId, accountId: 'credit-pool', type: 'CREDIT', amountMinor: amount, currency, description: 'Credit line draw', idempotencyKey },
])
```

## Repayment (linked back to original draw)
Store the original draw's `transactionId` on the repayment row so disputes and audits can trace the full lifecycle:

```ts
const repayTxId = crypto.randomUUID()
await postTransaction(db, [
  { transactionId: repayTxId, accountId: 'credit-pool', type: 'DEBIT',  amountMinor: amount, currency, description: `Repayment for draw ${originalTxId}`, idempotencyKey },
  { transactionId: repayTxId, accountId: userId, type: 'CREDIT', amountMinor: amount, currency, description: `Repayment for draw ${originalTxId}`, idempotencyKey },
])
```

## Required test
```ts
it('transaction entries balance to zero', () => {
  const entries = buildEntries(...)
  const net = entries.reduce((s, e) => e.type === 'DEBIT' ? s + e.amountMinor : s - e.amountMinor, 0)
  expect(net).toBe(0)
})
```

## Checklist
- [ ] All entries share the same `transactionId`
- [ ] Debit total === Credit total (same currency)
- [ ] `idempotencyKey` set from request header
- [ ] Audit log entry references the `transactionId`
- [ ] Balance invariant test written
