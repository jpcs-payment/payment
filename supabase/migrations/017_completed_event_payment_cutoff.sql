alter table public.events
  add column if not exists completed boolean not null default false;

create or replace function public.submit_payment(
  p_member uuid,
  p_event uuid,
  p_amount numeric,
  p_method text,
  p_reference text default null,
  p_receipt text default null
)
returns public.payments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event public.events%rowtype;
  v_reg public.registrations%rowtype;
  v_used numeric;
  v_remaining numeric;
  v_payment public.payments%rowtype;
begin
  if not exists (select 1 from public.profiles where id = p_member) then
    raise exception 'Profile required';
  end if;
  if p_amount <= 0 or p_method not in ('cash', 'gcash', 'maribank') then
    raise exception 'Invalid amount or payment method';
  end if;
  if p_method = 'cash' and p_receipt is not null then
    raise exception 'Cash payment cannot include receipt';
  end if;
  if p_method <> 'cash' and (p_receipt is null or split_part(p_receipt, '/', 1) <> p_member::text) then
    raise exception 'Receipt required';
  end if;

  select * into v_event
  from public.events
  where id = p_event and active
  for share;
  if not found then raise exception 'Event or payment method unavailable'; end if;
  if v_event.completed or (v_event.event_date is not null and v_event.event_date <= now()) then
    raise exception 'Payments are closed for this completed event';
  end if;
  if not (p_method = any(v_event.methods)) then
    raise exception 'Event or payment method unavailable';
  end if;

  insert into public.registrations(member_id, event_id, price)
  select p_member, p_event, price from public.events where id = p_event
  on conflict (member_id, event_id) do nothing;

  select * into v_reg from public.registrations
  where member_id = p_member and event_id = p_event for update;
  select coalesce(sum(amount), 0) into v_used from public.payments
  where registration_id = v_reg.id and state in ('approved', 'pending');
  v_remaining := v_reg.price - v_used;

  if p_amount > v_remaining then raise exception 'Payment exceeds remaining available balance'; end if;
  if not v_event.partial_payments_enabled and p_amount <> v_remaining then
    raise exception 'This event requires payment of the full remaining balance';
  end if;

  insert into public.payments(registration_id, amount, method, transaction_reference, receipt_path)
  values (v_reg.id, p_amount, p_method, nullif(p_reference, ''), p_receipt)
  returning * into v_payment;
  insert into public.audit_log(actor, action, entity, entity_id, detail)
  values (p_member, 'submitted', 'payment', v_payment.id::text,
    jsonb_build_object('registration_id', v_reg.id, 'amount', p_amount, 'method', p_method));
  return v_payment;
end;
$$;

revoke all on function public.submit_payment(uuid, uuid, numeric, text, text, text) from public, anon, authenticated;
grant execute on function public.submit_payment(uuid, uuid, numeric, text, text, text) to service_role;

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
  if v_event.completed or (v_event.event_date is not null and v_event.event_date <= now()) then
    raise exception 'Payments are closed for this completed event';
  end if;
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

revoke all on function public.submit_pay_later(uuid,uuid) from public,anon,authenticated;
grant execute on function public.submit_pay_later(uuid,uuid) to service_role;
