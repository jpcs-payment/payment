-- Remove conflicting permissive policies from the application tables and
-- replace them with explicit owner/admin access. This migration intentionally
-- does not alter Supabase-owned storage.objects; manage that table's policies
-- through the Supabase Storage Policies dashboard.
do $$
declare
  target record;
  existing_policy record;
begin
  for target in
    select * from (values
      ('public','profiles'),
      ('public','events'),
      ('public','registrations'),
      ('public','payments'),
      ('public','passes'),
      ('public','email_outbox'),
      ('public','audit_log'),
      ('public','student_directory_imports'),
      ('public','student_directory_records')
    ) as tables_to_harden(schema_name, table_name)
  loop
    for existing_policy in
      select policyname from pg_policies
      where schemaname=target.schema_name and tablename=target.table_name
    loop
      execute format('drop policy %I on %I.%I', existing_policy.policyname, target.schema_name, target.table_name);
    end loop;
  end loop;
end $$;

alter table public.profiles enable row level security;
alter table public.events enable row level security;
alter table public.registrations enable row level security;
alter table public.payments enable row level security;
alter table public.passes enable row level security;
alter table public.email_outbox enable row level security;
alter table public.audit_log enable row level security;
alter table public.student_directory_imports enable row level security;
alter table public.student_directory_records enable row level security;

-- Do not rely on Supabase's project-wide default table grants. Client writes
-- for profiles, payments, registrations, passes, and audit data go through the
-- authenticated Edge Function; event writes remain direct but admin-only by RLS.
revoke all on table public.profiles, public.events, public.registrations,
  public.payments, public.passes, public.email_outbox, public.audit_log,
  public.student_directory_imports, public.student_directory_records
  from public, anon, authenticated;

grant select on table public.profiles, public.events, public.registrations,
  public.payments, public.passes, public.audit_log to authenticated;
grant insert, update, delete on table public.events to authenticated;
grant all on table public.profiles, public.events, public.registrations,
  public.payments, public.passes, public.email_outbox, public.audit_log,
  public.student_directory_imports, public.student_directory_records to service_role;

-- A member can see their complete own profile. Only the actual admin role can
-- list other profiles, including the private directory fields on this table.
create policy profiles_select_self_or_admin on public.profiles
  for select to authenticated
  using (id=auth.uid() or (public.current_role()='admin' and public.password_changed()));

create policy events_select_active_or_admin on public.events
  for select to authenticated
  using ((active and public.password_changed()) or (public.current_role()='admin' and public.password_changed()));
create policy events_admin_manage on public.events
  for all to authenticated
  using (public.current_role()='admin' and public.password_changed())
  with check (public.current_role()='admin' and public.password_changed());

create policy registrations_select_owner_or_admin on public.registrations
  for select to authenticated
  using ((member_id=auth.uid() and public.password_changed()) or
    (public.current_role()='admin' and public.password_changed()));

create policy payments_select_owner_or_admin on public.payments
  for select to authenticated
  using (public.password_changed() and exists (
    select 1 from public.registrations r
    where r.id=payments.registration_id
      and (r.member_id=auth.uid() or public.current_role()='admin')
  ));

create policy passes_select_owner_or_admin on public.passes
  for select to authenticated
  using (public.password_changed() and exists (
    select 1 from public.registrations r
    where r.id=passes.registration_id
      and (r.member_id=auth.uid() or public.current_role()='admin')
  ));

create policy audit_log_admin_read on public.audit_log
  for select to authenticated
  using (public.current_role()='admin' and public.password_changed());

-- email_outbox and the student-directory import tables intentionally have no
-- client policies or grants; only the service-role Edge Function uses them.

-- Secure-by-default function execution. Service-only business RPCs remain
-- service-role-only; these two helpers are required by authenticated RLS rules.
grant execute on function public.current_role() to anon, authenticated;
grant execute on function public.password_changed() to anon, authenticated;

-- The payment-review RPC is callable only by service_role, but keep its own
-- authorization check aligned with the Edge Function's exact admin boundary.
create or replace function public.review_payment(
  p_payment uuid,
  p_actor uuid,
  p_decision public.payment_state,
  p_remarks text default ''
)
returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  v_payment public.payments%rowtype;
  v_registration public.registrations%rowtype;
  v_event public.events%rowtype;
  v_profile public.profiles%rowtype;
  v_paid numeric(10,2);
  v_price numeric(10,2);
  v_pass public.passes%rowtype;
  v_reuse_pay_later_qr boolean := false;
begin
  if p_decision not in ('approved','rejected') then raise exception 'Invalid review decision'; end if;
  if not exists(select 1 from public.profiles where id=p_actor and role='admin') then
    raise exception 'Administrator access required';
  end if;

  select * into v_payment from public.payments where id=p_payment for update;
  if not found or v_payment.state<>'pending' then raise exception 'Payment was already reviewed'; end if;
  select * into v_registration from public.registrations where id=v_payment.registration_id for update;
  select * into v_event from public.events where id=v_registration.event_id;
  v_price:=v_registration.price;
  select * into v_profile from public.profiles where id=v_registration.member_id;

  update public.payments
    set state=p_decision,remarks=p_remarks,reviewed_by=p_actor,reviewed_at=now()
    where id=p_payment returning * into v_payment;
  insert into public.audit_log(actor,action,entity,entity_id,detail)
    values(p_actor,p_decision::text,'payment',p_payment::text,jsonb_build_object('remarks',p_remarks));

  select coalesce(sum(amount),0) into v_paid from public.payments
    where registration_id=v_registration.id and state='approved';
  if v_paid>v_price then raise exception 'Approved payments exceed registered event price'; end if;
  if p_decision='approved' and v_paid=v_price then
    select * into v_pass from public.passes where registration_id=v_registration.id for update;
    v_reuse_pay_later_qr:=coalesce(v_pass.pay_later,false);
    insert into public.passes(registration_id,pay_later) values(v_registration.id,false)
      on conflict(registration_id) do update set pay_later=false returning * into v_pass;
    insert into public.email_outbox(dedupe_key,recipient,template,payload)
      values('final:'||v_registration.id::text,v_profile.email,'final_payment',jsonb_build_object(
        'name',v_profile.full_name,'event',v_event.name,'total',v_price,'token',v_pass.token,
        'include_pass_qr',not v_reuse_pay_later_qr
      )) on conflict(dedupe_key) do nothing;
  else
    insert into public.email_outbox(dedupe_key,recipient,template,payload)
      values('review:'||v_payment.id::text,v_profile.email,'payment_'||p_decision::text,
        jsonb_build_object('name',v_profile.full_name,'event',v_event.name,'amount',v_payment.amount,'remarks',p_remarks))
      on conflict(dedupe_key) do nothing;
  end if;

  return jsonb_build_object(
    'payment',to_jsonb(v_payment),'approvedTotal',v_paid,
    'balance',greatest(0,v_price-v_paid),'fullyPaid',v_paid=v_price,
    'pass',case when v_paid=v_price then to_jsonb(v_pass) else null end,
    'reusedPayLaterQr',v_reuse_pay_later_qr
  );
end;
$$;
revoke all on function public.review_payment(uuid,uuid,public.payment_state,text) from public,anon,authenticated;
grant execute on function public.review_payment(uuid,uuid,public.payment_state,text) to service_role;
