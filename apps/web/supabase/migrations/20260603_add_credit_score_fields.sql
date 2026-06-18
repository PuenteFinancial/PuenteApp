alter table waitlist
  add column if not exists knows_credit_score text,
  add column if not exists credit_score_range text;
