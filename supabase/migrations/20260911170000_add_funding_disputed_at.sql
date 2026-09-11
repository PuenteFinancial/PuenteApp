-- Migration: transfers.funding_disputed_at — a durable mark that this transfer's funding was disputed
-- Created: 20260911170000 (renumbered from 20260910190000 — see the commit)
-- Rollback: alter table public.transfers drop column funding_disputed_at;

-- Found by the staging drive 2026-09-10, and it is an ORDERING bug of exactly
-- the family that cost us two bugs in C5: Stripe guarantees no ordering
-- BETWEEN event types.
--
-- The dispute test card raises `charge.dispute.created` about two seconds
-- after the charge, which beat `checkout.session.completed` to our webhook.
-- The loss path therefore looked at a transfer still in PENDING_PAYMENT,
-- correctly concluded there was no exposure YET, froze the sender and booked
-- nothing — and left NO MARK ON THE TRANSFER. The funding event then arrived
-- and funded it normally. The payout was stopped only incidentally, because
-- the sender happened to be frozen.
--
-- A boolean would do, but a timestamp answers "when" for free and matches
-- payout_held_at / fx_rate_at. Deliberately NOT a state: a dispute can land at
-- any point in a transfer's life, exactly like funding_cleared, and both are
-- facts about the money rather than positions in the machine.
--
-- Readers: applyFundingSucceeded catches up on it after its own commit (the
-- same shape as the funding_cleared catch-up next to it), and
-- reconciliation's stripe_disputes check reads it as THE mark a dispute must
-- have left. Nullable with no default, so every existing row reads "never
-- disputed", which is true.
alter table public.transfers
  add column funding_disputed_at timestamptz;

-- The reconciliation sweep asks "which transfers were disputed", never the
-- other way round, and disputes are rare — a partial index keeps it to the
-- handful of rows that matter.
create index if not exists transfers_funding_disputed_at_idx
  on public.transfers (funding_disputed_at)
  where funding_disputed_at is not null;
