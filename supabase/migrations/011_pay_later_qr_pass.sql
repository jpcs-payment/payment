-- Give Pay Later obligations a real JPCS token. It is counted with issued QR
-- tokens but is explicitly blocked from check-in until converted to a paid pass.
alter table public.passes
  add column if not exists pay_later boolean not null default false;

create or replace function public.submit_pay_later(p_member uuid, p_event uuid)
returns public.registrations language plpgsql security definer set search_path=public as $$
declare
  v_event public.events%rowtype;
  v_registration public.registrations%rowtype;
  v_profile public.profiles%rowtype;
  v_pass public.passes%rowtype;
  v_approved numeric(10,2);
  v_due numeric(10,2);
begin
  if not exists(select 1 from public.profiles where id=p_member) then
    raise exception 'Profile required';
  end if;
  select * into v_event from public.events where id=p_event and active for share;
  if not found then raise exception 'Event unavailable'; end if;
  if not v_event.pay_later_enabled then raise exception 'Pay Later is not enabled for this event'; end if;
  if v_event.price <= 0 then raise exception 'Pay Later is only available for paid events'; end if;

  insert into public.registrations(member_id,event_id,price)
    values(p_member,p_event,v_event.price) on conflict(member_id,event_id) do nothing;
  select * into v_registration from public.registrations
    where member_id=p_member and event_id=p_event for update;
  select coalesce(sum(amount),0) into v_approved from public.payments
    where registration_id=v_registration.id and state='approved';
  v_due:=greatest(0,v_registration.price-v_approved);
  if v_due <= 0 then raise exception 'This event is already fully paid'; end if;

  if v_registration.pay_later_started_at is null then
    update public.registrations
      set pay_later_started_at=now(), pay_later_due_at=now()+interval '3 days'
      where id=v_registration.id returning * into v_registration;
    insert into public.passes(registration_id,pay_later)
      values(v_registration.id,true)
      on conflict(registration_id) do update set pay_later=true
      returning * into v_pass;
    select * into v_profile from public.profiles where id=p_member;
    insert into public.email_outbox(dedupe_key,recipient,template,payload)
      values(
        'pay-later:'||v_registration.id::text,
        v_profile.email,
        'pay_later',
        jsonb_build_object(
          'name',v_profile.full_name,
          'event',v_event.name,
          'amount',v_due,
          'due_at',v_registration.pay_later_due_at,
          'token',v_pass.token
        )
      ) on conflict(dedupe_key) do update set
        recipient=excluded.recipient,
        template=excluded.template,
        payload=excluded.payload,
        sent_at=null,
        claimed_at=null;
    insert into public.audit_log(actor,action,entity,entity_id,detail)
      values(p_member,'pay_later_started','registration',v_registration.id::text,
        jsonb_build_object('event_id',p_event,'due_at',v_registration.pay_later_due_at,'amount',v_due));
  else
    insert into public.passes(registration_id,pay_later)
      values(v_registration.id,true)
      on conflict(registration_id) do update set pay_later=true returning * into v_pass;
  end if;
  return v_registration;
end $$;

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
    insert into public.passes(registration_id,pay_later) values(v_registration.id,false)
      on conflict(registration_id) do update set pay_later=false returning * into v_pass;
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

create or replace function public.delete_payment(p_payment uuid, p_actor uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_payment public.payments%rowtype;
  v_registration public.registrations%rowtype;
  v_approved numeric(10,2);
  v_pass_revoked boolean := false;
begin
  if not exists(select 1 from public.profiles where id=p_actor and role='admin') then raise exception 'Administrator access required'; end if;
  select * into v_payment from public.payments where id=p_payment for update;
  if not found then raise exception 'Payment not found'; end if;
  select * into v_registration from public.registrations where id=v_payment.registration_id for update;
  insert into public.audit_log(actor,action,entity,entity_id,detail)
    values(p_actor,'deleted','payment',v_payment.id::text,jsonb_build_object('registration_id',v_payment.registration_id,'amount',v_payment.amount,'method',v_payment.method,'state',v_payment.state,'remarks',v_payment.remarks));
  delete from public.payments where id=p_payment;
  if v_payment.state='approved' then
    select coalesce(sum(amount),0) into v_approved from public.payments where registration_id=v_registration.id and state='approved';
    if v_approved < v_registration.price then
      if v_registration.pay_later_started_at is not null then
        insert into public.passes(registration_id,pay_later) values(v_registration.id,true)
          on conflict(registration_id) do update set pay_later=true;
      else
        delete from public.passes where registration_id=v_registration.id;
        v_pass_revoked := found;
      end if;
      delete from public.email_outbox where dedupe_key='final:'||v_registration.id::text;
    end if;
  end if;
  return jsonb_build_object('paymentId',p_payment,'passRevoked',v_pass_revoked);
end $$;

create or replace function public.delete_pay_later(p_registration uuid, p_actor uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_registration public.registrations%rowtype;
begin
  if not exists(select 1 from public.profiles where id=p_actor and role='admin') then raise exception 'Administrator access required'; end if;
  select * into v_registration from public.registrations where id=p_registration for update;
  if not found then raise exception 'Registration not found'; end if;
  if v_registration.pay_later_started_at is null then raise exception 'This registration has no Pay Later obligation'; end if;
  insert into public.audit_log(actor,action,entity,entity_id,detail)
    values(p_actor,'deleted','pay_later',v_registration.id::text,jsonb_build_object('event_id',v_registration.event_id,'member_id',v_registration.member_id,'started_at',v_registration.pay_later_started_at,'due_at',v_registration.pay_later_due_at));
  update public.registrations set pay_later_started_at=null,pay_later_due_at=null where id=v_registration.id;
  delete from public.passes where registration_id=v_registration.id and pay_later=true;
  delete from public.email_outbox where dedupe_key='pay-later:'||v_registration.id::text;
  return jsonb_build_object('registrationId',v_registration.id);
end $$;

revoke all on function public.submit_pay_later(uuid,uuid) from public,anon,authenticated;
grant execute on function public.submit_pay_later(uuid,uuid) to service_role;
revoke all on function public.review_payment(uuid,uuid,public.payment_state,text) from public,anon,authenticated;
grant execute on function public.review_payment(uuid,uuid,public.payment_state,text) to service_role;
revoke all on function public.delete_payment(uuid,uuid) from public,anon,authenticated;
grant execute on function public.delete_payment(uuid,uuid) to service_role;
revoke all on function public.delete_pay_later(uuid,uuid) from public,anon,authenticated;
grant execute on function public.delete_pay_later(uuid,uuid) to service_role;

-- Backfill active Pay Later records created before this QR/pass upgrade and
-- queue an updated email containing the newly created JPCS token QR.
insert into public.passes(registration_id,pay_later)
select r.id,true from public.registrations r
where r.pay_later_started_at is not null
  and r.price>coalesce((select sum(x.amount) from public.payments x where x.registration_id=r.id and x.state='approved'),0)
on conflict(registration_id) do update set pay_later=true;

update public.passes pass set pay_later=false
where pass.registration_id in (
  select r.id from public.registrations r
  where r.pay_later_started_at is not null
    and r.price<=coalesce((select sum(x.amount) from public.payments x where x.registration_id=r.id and x.state='approved'),0)
);

insert into public.email_outbox(dedupe_key,recipient,template,payload)
select 'pay-later:'||r.id::text,p.email,'pay_later',
  jsonb_build_object('name',p.full_name,'event',e.name,
    'amount',greatest(0,r.price-coalesce((select sum(x.amount) from public.payments x where x.registration_id=r.id and x.state='approved'),0)),
    'due_at',r.pay_later_due_at,'token',pass.token)
from public.registrations r
join public.profiles p on p.id=r.member_id
join public.events e on e.id=r.event_id
join public.passes pass on pass.registration_id=r.id
where r.pay_later_started_at is not null and pass.pay_later
  and r.price>coalesce((select sum(x.amount) from public.payments x where x.registration_id=r.id and x.state='approved'),0)
on conflict(dedupe_key) do update set
  recipient=excluded.recipient,template=excluded.template,payload=excluded.payload,
  sent_at=null,claimed_at=null;
