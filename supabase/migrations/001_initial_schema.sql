-- Run in the Supabase SQL editor. Create users through the Supabase Auth dashboard;
-- never expose the service-role key to the browser.
create extension if not exists pgcrypto;
create type public.app_role as enum ('member','treasurer','auditor','admin');
create type public.payment_state as enum ('pending','approved','rejected');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null default '', email text not null unique,
  student_number text, year_level smallint check (year_level between 1 and 4),
  role public.app_role not null default 'member', must_change_password boolean not null default true,
  created_at timestamptz not null default now()
);
create table public.events (
  id uuid primary key default gen_random_uuid(), name text not null, description text not null default '',
  price numeric(10,2) not null check (price >= 0), event_date timestamptz, venue text,
  payment_deadline timestamptz, active boolean not null default true,
  methods text[] not null default array['cash','gcash','maribank'], instructions jsonb not null default '{}'::jsonb,
  payment_instructions text not null default '',
  created_at timestamptz not null default now()
);
create table public.registrations (
  id uuid primary key default gen_random_uuid(), member_id uuid not null references public.profiles(id),
  event_id uuid not null references public.events(id), price numeric(10,2) not null check (price>=0),
  created_at timestamptz not null default now(),
  unique(member_id,event_id)
);
create table public.payments (
  id uuid primary key default gen_random_uuid(), registration_id uuid not null references public.registrations(id),
  amount numeric(10,2) not null check (amount > 0), method text not null check (method in ('cash','gcash','maribank')),
  transaction_reference text, receipt_path text, state public.payment_state not null default 'pending',
  submitted_at timestamptz not null default now(), reviewed_by uuid references public.profiles(id), reviewed_at timestamptz,
  remarks text, check (state = 'pending' or (reviewed_by is not null and reviewed_at is not null))
);
create table public.passes (
  id uuid primary key default gen_random_uuid(), registration_id uuid not null unique references public.registrations(id),
  token uuid not null unique default gen_random_uuid(), issued_at timestamptz not null default now(),
  checked_in_at timestamptz, checked_in_by uuid references public.profiles(id)
);
create table public.email_outbox (
  id uuid primary key default gen_random_uuid(), dedupe_key text not null unique,
  recipient text not null, template text not null, payload jsonb not null default '{}'::jsonb,
  sent_at timestamptz, created_at timestamptz not null default now()
);
create table public.audit_log (
  id bigint generated always as identity primary key, actor uuid references public.profiles(id),
  action text not null, entity text not null, entity_id text not null, detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- A single transaction serializes reviews for one registration and ensures a
-- final pass/email is created at most once, even when two officers review concurrently.
create or replace function public.review_payment(p_payment uuid, p_actor uuid, p_decision public.payment_state, p_remarks text default '')
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_payment public.payments%rowtype;
  v_registration public.registrations%rowtype;
  v_event public.events%rowtype;
  v_profile public.profiles%rowtype;
  v_paid numeric(10,2);
  v_price numeric(10,2);
  v_pass public.passes%rowtype;
begin
  if p_decision not in ('approved','rejected') then raise exception 'Invalid review decision'; end if;
  if not exists(select 1 from public.profiles where id=p_actor and role <> 'member') then raise exception 'Officer access required'; end if;
  select * into v_payment from public.payments where id=p_payment for update;
  if not found or v_payment.state <> 'pending' then raise exception 'Payment was already reviewed'; end if;
  select * into v_registration from public.registrations where id=v_payment.registration_id for update;
  select * into v_event from public.events where id=v_registration.event_id;
  v_price:=v_registration.price;
  select * into v_profile from public.profiles where id=v_registration.member_id;
  update public.payments set state=p_decision, remarks=p_remarks, reviewed_by=p_actor, reviewed_at=now() where id=p_payment returning * into v_payment;
  insert into public.audit_log(actor,action,entity,entity_id,detail) values(p_actor,p_decision::text,'payment',p_payment::text,jsonb_build_object('remarks',p_remarks));
  select coalesce(sum(amount),0) into v_paid from public.payments where registration_id=v_registration.id and state='approved';
  if v_paid > v_price then raise exception 'Approved payments exceed registered event price'; end if;
  if p_decision='approved' and v_paid=v_price then
    insert into public.passes(registration_id) values(v_registration.id) on conflict(registration_id) do nothing;
    select * into v_pass from public.passes where registration_id=v_registration.id;
    insert into public.email_outbox(dedupe_key,recipient,template,payload)
      values('final:'||v_registration.id::text,v_profile.email,'final_payment',jsonb_build_object('name',v_profile.full_name,'event',v_event.name,'total',v_price,'token',v_pass.token))
      on conflict(dedupe_key) do nothing;
  else
    insert into public.email_outbox(dedupe_key,recipient,template,payload)
      values('review:'||v_payment.id::text,v_profile.email,'payment_'||p_decision::text,jsonb_build_object('name',v_profile.full_name,'event',v_event.name,'amount',v_payment.amount,'remarks',p_remarks))
      on conflict(dedupe_key) do nothing;
  end if;
  return jsonb_build_object('payment',to_jsonb(v_payment),'approvedTotal',v_paid,'balance',greatest(0,v_price-v_paid),'fullyPaid',v_paid=v_price,'pass',case when v_paid=v_price then to_jsonb(v_pass) else null end);
end $$;
revoke all on function public.review_payment(uuid,uuid,public.payment_state,text) from public, anon, authenticated;
grant execute on function public.review_payment(uuid,uuid,public.payment_state,text) to service_role;

create or replace function public.submit_payment(p_member uuid,p_event uuid,p_amount numeric,p_method text,p_reference text default null,p_receipt text default null)
returns public.payments language plpgsql security definer set search_path=public as $$
declare v_event public.events%rowtype; v_reg public.registrations%rowtype; v_used numeric; v_payment public.payments%rowtype;
begin
 if not exists(select 1 from public.profiles where id=p_member) then raise exception 'Profile required'; end if;
 if p_amount<=0 or p_method not in ('cash','gcash','maribank') then raise exception 'Invalid amount or payment method'; end if;
 if p_method='cash' and p_receipt is not null then raise exception 'Cash payment cannot include receipt'; end if;
 if p_method<>'cash' and (p_receipt is null or split_part(p_receipt,'/',1)<>p_member::text) then raise exception 'Receipt required'; end if;
 select * into v_event from public.events where id=p_event and active for share;
 if not found or not (p_method=any(v_event.methods)) then raise exception 'Event or payment method unavailable'; end if;
  insert into public.registrations(member_id,event_id,price) select p_member,p_event,price from public.events where id=p_event on conflict(member_id,event_id) do nothing;
 select * into v_reg from public.registrations where member_id=p_member and event_id=p_event for update;
 select coalesce(sum(amount),0) into v_used from public.payments where registration_id=v_reg.id and state in ('approved','pending');
  if p_amount>v_reg.price-v_used then raise exception 'Payment exceeds remaining available balance'; end if;
 insert into public.payments(registration_id,amount,method,transaction_reference,receipt_path) values(v_reg.id,p_amount,p_method,nullif(p_reference,''),p_receipt) returning * into v_payment;
 insert into public.audit_log(actor,action,entity,entity_id,detail) values(p_member,'submitted','payment',v_payment.id::text,jsonb_build_object('registration_id',v_reg.id,'amount',p_amount,'method',p_method));
 return v_payment;
end $$;
revoke all on function public.submit_payment(uuid,uuid,numeric,text,text,text) from public,anon,authenticated;
grant execute on function public.submit_payment(uuid,uuid,numeric,text,text,text) to service_role;

create or replace function public.current_role() returns public.app_role language sql stable security definer set search_path=public
as $$ select role from public.profiles where id=auth.uid() $$;
create or replace function public.password_changed() returns boolean language sql stable security definer set search_path=public
as $$ select coalesce((select not must_change_password from public.profiles where id=auth.uid()),false) $$;
create or replace function public.acknowledge_password_change() returns void language plpgsql security definer set search_path=public
as $$ begin update public.profiles set must_change_password=false where id=auth.uid(); end $$;
revoke all on function public.acknowledge_password_change() from public,anon,authenticated;
alter table public.profiles enable row level security;
alter table public.events enable row level security;
alter table public.registrations enable row level security;
alter table public.payments enable row level security;
alter table public.passes enable row level security;
alter table public.email_outbox enable row level security;
alter table public.audit_log enable row level security;
create policy "profiles self or officers read" on public.profiles for select to authenticated using (id=auth.uid() or public.current_role() <> 'member');
create policy "events visible" on public.events for select to authenticated using ((active and public.password_changed()) or (public.current_role() <> 'member' and public.password_changed()));
create policy "officers manage events" on public.events for all to authenticated using (public.current_role() <> 'member' and public.password_changed()) with check (public.current_role() <> 'member' and public.password_changed());
create policy "registrations self or officers" on public.registrations for select to authenticated using ((member_id=auth.uid() and public.password_changed()) or (public.current_role() <> 'member' and public.password_changed()));
-- Registrations are created by the trusted payment RPC, which snapshots event price.
create policy "payment read self or officers" on public.payments for select to authenticated using (exists(select 1 from public.registrations r where r.id=registration_id and ((r.member_id=auth.uid() and public.password_changed()) or (public.current_role() <> 'member' and public.password_changed()))));
-- Payment inserts are made only through the server's validated submit_payment RPC.
create policy "pass read owner or officers" on public.passes for select to authenticated using (exists(select 1 from public.registrations r where r.id=registration_id and ((r.member_id=auth.uid() and public.password_changed()) or (public.current_role() <> 'member' and public.password_changed()))));
create policy "officers read audit" on public.audit_log for select to authenticated using (public.current_role() <> 'member' and public.password_changed());
-- No client update policies for payments, roles, passes, audit log, or outbox.
-- Approval and pass issuance must occur through a trusted Node server/RPC.

create or replace function public.audit_event_change() returns trigger language plpgsql security definer set search_path=public as $$
declare v_id text; v_name text;
begin
 if tg_op='DELETE' then v_id:=old.id::text; v_name:=old.name; else v_id:=new.id::text; v_name:=new.name; end if;
 insert into public.audit_log(actor,action,entity,entity_id,detail)
 values(auth.uid(),lower(tg_op),'event',v_id,jsonb_build_object('name',v_name));
 if tg_op='DELETE' then return old; end if; return new;
end $$;
create trigger events_audit after insert or update or delete on public.events for each row execute function public.audit_event_change();

insert into public.events(name,description,price,active) values
 ('Film Showing','JPCS community film showing.',50,true),
 ('Bootcamp','JPCS skills and learning bootcamp.',1200,true),
 ('Jacket','Official JPCS organization jacket.',850,true),
 ('Field Trip','JPCS organization field trip.',3000,true)
on conflict do nothing;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('payment-receipts','payment-receipts',false,5242880,array['image/jpeg','image/png','image/webp'])
on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
create policy "receipt owner or officer read" on storage.objects for select to authenticated using (bucket_id='payment-receipts' and public.password_changed() and (public.current_role() <> 'member' or exists(select 1 from public.payments p join public.registrations r on r.id=p.registration_id where p.receipt_path=name and r.member_id=auth.uid())));
create policy "member upload own receipt path" on storage.objects for insert to authenticated with check (bucket_id='payment-receipts' and public.password_changed() and (storage.foldername(name))[1]=auth.uid()::text);
