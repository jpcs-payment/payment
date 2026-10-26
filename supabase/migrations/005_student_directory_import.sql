-- Preserve source directory data independently from auth profiles. Existing
-- profiles require an auth.users row and a unique, non-null email, so incomplete
-- directory records can be retained without inventing identities or emails.
alter table public.profiles
  add column if not exists last_name text,
  add column if not exists first_name text,
  add column if not exists middle_initial text,
  add column if not exists program text,
  add column if not exists sex text,
  add column if not exists contact_number text,
  add column if not exists address text;

create table if not exists public.student_directory_imports (
  id uuid primary key default gen_random_uuid(),
  fingerprint text not null unique check (fingerprint ~ '^[a-f0-9]{64}$'),
  source_filename text not null,
  expected_records integer not null default 94,
  detected_records integer not null default 0,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);

create table if not exists public.student_directory_records (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references public.student_directory_imports(id) on delete cascade,
  record_index integer not null check (record_index between 1 and 200),
  directory_row integer not null check (directory_row between 1 and 94),
  student_number text,
  last_name text,
  first_name text,
  middle_initial text,
  program text,
  year_level smallint,
  sex text,
  email text,
  contact_number text,
  address text,
  status text not null check (status in ('processing','imported','incomplete','duplicate','excluded','failed')),
  notes text[] not null default '{}',
  profile_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  unique(import_id, record_index)
);

create index if not exists student_directory_records_profile_idx on public.student_directory_records(profile_id);
create index if not exists student_directory_records_status_idx on public.student_directory_records(import_id, status);

alter table public.student_directory_imports enable row level security;
alter table public.student_directory_records enable row level security;
-- Service-role-only writes are performed by the authenticated, admin-checked
-- jpcs-api Edge Function. No directory records are exposed directly to clients.
