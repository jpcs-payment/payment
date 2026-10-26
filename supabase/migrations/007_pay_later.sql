-- Optional Pay Later obligations are tracked on registrations, not as payment
-- submissions, so they never enter the payment approval workflow.
alter table public.events
  add column if not exists pay_later_enabled boolean not null default false;

alter table public.registrations
  add column if not exists pay_later_started_at timestamptz,
  add column if not exists pay_later_due_at timestamptz;

create or replace function public.submit_pay_later(p_member uuid, p_event uuid)
returns public.registrations language plpgsql security definer set search_path=public as $$
declare
  v_event public.events%rowtype;
  v_registration public.registrations%rowtype;
  v_profile public.profiles%rowtype;
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
          'due_at',v_registration.pay_later_due_at
        )
      ) on conflict(dedupe_key) do nothing;
  end if;
  insert into public.audit_log(actor,action,entity,entity_id,detail)
    values(p_member,'pay_later_started','registration',v_registration.id::text,
      jsonb_build_object('event_id',p_event,'due_at',v_registration.pay_later_due_at,'amount',v_due));
  return v_registration;
end $$;

revoke all on function public.submit_pay_later(uuid,uuid) from public,anon,authenticated;
grant execute on function public.submit_pay_later(uuid,uuid) to service_role;
