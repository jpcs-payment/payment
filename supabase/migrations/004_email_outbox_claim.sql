-- Used by the hosted jpcs-api Edge Function to avoid concurrent email sends.
alter table public.email_outbox add column if not exists claimed_at timestamptz;
