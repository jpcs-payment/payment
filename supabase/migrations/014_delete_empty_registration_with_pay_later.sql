-- Cancelling a Pay Later obligation removes its registration when it has no
-- payment history; otherwise retain the registration and payment records.
create or replace function public.delete_pay_later(p_registration uuid, p_actor uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_registration public.registrations%rowtype;
  v_payment_count integer;
  v_pass public.passes%rowtype;
  v_registration_deleted boolean := false;
begin
  if not exists(select 1 from public.profiles where id=p_actor and role='admin') then
    raise exception 'Administrator access required';
  end if;

  select * into v_registration from public.registrations
    where id=p_registration for update;
  if not found then raise exception 'Registration not found'; end if;
  if v_registration.pay_later_started_at is null then
    raise exception 'This registration has no Pay Later obligation';
  end if;

  select count(*) into v_payment_count from public.payments
    where registration_id=v_registration.id;

  insert into public.audit_log(actor,action,entity,entity_id,detail)
    values(p_actor,'deleted','pay_later',v_registration.id::text,
      jsonb_build_object(
        'event_id',v_registration.event_id,
        'member_id',v_registration.member_id,
        'started_at',v_registration.pay_later_started_at,
        'due_at',v_registration.pay_later_due_at,
        'payment_count',v_payment_count
      ));

  if v_payment_count=0 then
    select * into v_pass from public.passes where registration_id=v_registration.id for update;
    insert into public.audit_log(actor,action,entity,entity_id,detail)
      values(p_actor,'deleted','registration',v_registration.id::text,
        jsonb_build_object(
          'event_id',v_registration.event_id,
          'member_id',v_registration.member_id,
          'price',v_registration.price,
          'pass_id',v_pass.id,
          'checked_in_at',v_pass.checked_in_at,
          'reason','cancelled Pay Later with no payments'
        ));
    delete from public.passes where registration_id=v_registration.id;
    delete from public.registrations where id=v_registration.id;
    v_registration_deleted := found;
  else
    update public.registrations
      set pay_later_started_at=null, pay_later_due_at=null
      where id=v_registration.id;
  end if;

  delete from public.email_outbox
    where dedupe_key='pay-later:'||v_registration.id::text and sent_at is null;

  return jsonb_build_object(
    'registrationId',v_registration.id,
    'registrationDeleted',v_registration_deleted
  );
end $$;

revoke all on function public.delete_pay_later(uuid,uuid) from public,anon,authenticated;
grant execute on function public.delete_pay_later(uuid,uuid) to service_role;
