-- Let the site Admin cancel a Pay Later obligation without deleting the
-- member's registration or any actual payment history.
create or replace function public.delete_pay_later(p_registration uuid, p_actor uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_registration public.registrations%rowtype;
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

  insert into public.audit_log(actor,action,entity,entity_id,detail)
    values(p_actor,'deleted','pay_later',v_registration.id::text,
      jsonb_build_object(
        'event_id',v_registration.event_id,
        'member_id',v_registration.member_id,
        'started_at',v_registration.pay_later_started_at,
        'due_at',v_registration.pay_later_due_at
      ));

  update public.registrations
    set pay_later_started_at=null, pay_later_due_at=null
    where id=v_registration.id;
  delete from public.email_outbox
    where dedupe_key='pay-later:'||v_registration.id::text and sent_at is null;

  return jsonb_build_object('registrationId',v_registration.id);
end $$;

revoke all on function public.delete_pay_later(uuid,uuid) from public,anon,authenticated;
grant execute on function public.delete_pay_later(uuid,uuid) to service_role;
