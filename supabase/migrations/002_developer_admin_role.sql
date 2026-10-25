-- Apply after 001_initial_schema.sql to add a distinct full administrator role.
-- Run this once in Supabase SQL Editor. Role checks use `<> 'member'` so this
-- migration can run in the same SQL transaction as ALTER TYPE ADD VALUE.
alter type public.app_role add value if not exists 'admin';

drop policy if exists "profiles self or officers read" on public.profiles;
drop policy if exists "events visible" on public.events;
drop policy if exists "officers manage events" on public.events;
drop policy if exists "registrations self or officers" on public.registrations;
drop policy if exists "payment read self or officers" on public.payments;
drop policy if exists "pass read owner or officers" on public.passes;
drop policy if exists "officers read audit" on public.audit_log;
drop policy if exists "receipt owner or officer read" on storage.objects;

create policy "profiles self or officers read" on public.profiles for select to authenticated
using (id=auth.uid() or public.current_role() <> 'member');
create policy "events visible" on public.events for select to authenticated
using ((active and public.password_changed()) or (public.current_role() <> 'member' and public.password_changed()));
create policy "officers manage events" on public.events for all to authenticated
using (public.current_role() <> 'member' and public.password_changed())
with check (public.current_role() <> 'member' and public.password_changed());
create policy "registrations self or officers" on public.registrations for select to authenticated
using ((member_id=auth.uid() and public.password_changed()) or (public.current_role() <> 'member' and public.password_changed()));
create policy "payment read self or officers" on public.payments for select to authenticated
using (exists(select 1 from public.registrations r where r.id=registration_id and
 ((r.member_id=auth.uid() and public.password_changed()) or (public.current_role() <> 'member' and public.password_changed()))));
create policy "pass read owner or officers" on public.passes for select to authenticated
using (exists(select 1 from public.registrations r where r.id=registration_id and
 ((r.member_id=auth.uid() and public.password_changed()) or (public.current_role() <> 'member' and public.password_changed()))));
create policy "officers read audit" on public.audit_log for select to authenticated
using (public.current_role() <> 'member' and public.password_changed());
create policy "receipt owner or officer read" on storage.objects for select to authenticated
using (bucket_id='payment-receipts' and public.password_changed() and
 (public.current_role() <> 'member' or exists(select 1 from public.payments p join public.registrations r on r.id=p.registration_id where p.receipt_path=name and r.member_id=auth.uid())));

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
revoke all on function public.review_payment(uuid,uuid,public.payment_state,text) from public,anon,authenticated;
grant execute on function public.review_payment(uuid,uuid,public.payment_state,text) to service_role;

-- Allow the trusted Admin account to use its own member workspace for testing.
-- The user still has the admin role; this does not permit role self-assignment.
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
