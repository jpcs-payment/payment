-- Index foreign-key and sort columns used by workspace reads and admin queues.
create index if not exists registrations_event_id_idx
  on public.registrations(event_id);
create index if not exists registrations_created_at_idx
  on public.registrations(created_at desc);
create index if not exists registrations_member_created_at_idx
  on public.registrations(member_id, created_at desc);
create index if not exists payments_registration_id_idx
  on public.payments(registration_id);
create index if not exists payments_submitted_at_idx
  on public.payments(submitted_at desc);
create index if not exists events_event_date_idx
  on public.events(event_date asc nulls last);
create index if not exists profiles_full_name_idx
  on public.profiles(full_name);
