-- Migration: transfers.funding_processor — persist the rail that funded each row (audit 2026-09-02 corner 1)
-- Created: 20260903000538
-- Rollback: alter table public.transfers drop column funding_processor;
--
-- Until now every job acting on a transfer resolved its funding rail from the
-- PROCESS (env.FUNDING_PROCESSOR): the reaper's abandonment clock, which
-- adapter a refund or void runs on, whether an operator may record manual
-- funding. That is only correct while every row in the table was funded under
-- the deployment's current rail — and the K7 prod flip (manual → stripe_crypto)
-- would have reaped every pending manual row at 30 minutes and pointed manual
-- refunds at Stripe. This column is stamped at initiation so the ROW says what
-- funded it.
--
-- Nullable, no CHECK, deliberately: the value set lives in config/env.ts
-- (mock | stripe | manual | stripe_onramp | stripe_crypto) and a CHECK would
-- turn every new rail into the drop-and-re-add dance; readers go through
-- processorNameFor(row), which falls back to env.FUNDING_PROCESSOR for a null
-- — so a pre-migration row behaves exactly as before. NOT added to the
-- frozen-terms trigger: the null → value stamp is an UPDATE at confirm time.
-- funding_source_type (CHECK 'ach', frozen) is the sender's bank rail, a
-- different axis, and stays.
--
-- Backfill: only the unambiguous ref prefixes. cos_ is shared by stripe_onramp
-- and stripe_crypto (same session namespace, different auth) and is LEFT NULL
-- on purpose — the env fallback is today's behaviour; guessing would be worse.

alter table public.transfers add column funding_processor text;

comment on column public.transfers.funding_processor is
  'Which FUNDING_PROCESSOR funded this transfer, stamped at initiation. Null = pre-migration row; readers fall back to env.FUNDING_PROCESSOR (services/funding/index.ts processorNameFor).';

update public.transfers
set funding_processor = case
  when funding_payment_ref like 'pi\_%'        then 'stripe'
  when funding_payment_ref like 'mockpay\_%'   then 'mock'
  when funding_payment_ref like 'manualpay\_%' then 'manual'
end
where funding_processor is null
  and funding_payment_ref is not null
  and (
    funding_payment_ref like 'pi\_%'
    or funding_payment_ref like 'mockpay\_%'
    or funding_payment_ref like 'manualpay\_%'
  );
