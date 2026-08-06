-- Migration: waitlist duplicate-submission diagnostics
-- Created: 20260805134915
--
-- A duplicate waitlist row today carries no evidence of WHY it exists: two
-- successful inserts look identical whether the submitter retried after being
-- shown a false failure, came back a month later, or is a bot. These columns
-- make the next duplicate self-diagnosing.
--
--   submission_id      one id per form session, stable across retries within
--                      that session (a page reload starts a new one)
--   attempt            1 on the first POST, 2+ on a user-initiated retry
--   prior_error        what the client saw before retrying ('http_504',
--                      'http_500', 'transport') — null on attempt 1
--   client_distinct_id PostHog distinct id; links two SEPARATE form sessions
--                      coming from the same browser
--   phone_normalized   digits-only phone, generated — the raw column is free
--                      text, so '+1 (555) 123-4567' and '5551234567' are
--                      different strings and would defeat any lookup
--
-- Reading a duplicate pair:
--   same submission_id, attempt 1 then 2      -> retry after an apparent failure
--   same submission_id, both attempt 1        -> double-fire from a single click
--   different submission_id, same distinct id -> deliberate re-signup, same browser
--   no submission_id and no distinct id       -> non-browser caller (bot)
--   prior row has neither (predates this)     -> unclassifiable, wait for the next
--
-- The index is deliberately NOT unique. This migration only observes; it
-- changes no write behavior and can land on a table that already holds
-- duplicates. Enforcing uniqueness requires resolving the existing duplicates
-- first and is a separate, reviewed slice.
--
-- No new PII class: phone is already stored plaintext on this table (baseline
-- migration) and phone_normalized is derived from it. Neither column may be
-- logged — diagnostics carry a truncated hash instead.
--
-- Rollback:
--   drop index if exists waitlist_phone_normalized_idx;
--   alter table waitlist
--     drop column phone_normalized,
--     drop column client_distinct_id,
--     drop column prior_error,
--     drop column attempt,
--     drop column submission_id;

alter table waitlist
  add column submission_id      uuid,
  add column attempt            integer,
  add column prior_error        text,
  add column client_distinct_id text,
  -- regexp_replace is IMMUTABLE, which a stored generated column requires
  add column phone_normalized   text generated always as (regexp_replace(phone, '[^0-9]', '', 'g')) stored;

create index if not exists waitlist_phone_normalized_idx on waitlist (phone_normalized);
