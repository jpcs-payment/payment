-- Remove a payment's registration once its final payment is deleted.
-- Preserve audit history while cleaning up dependent pass/email rows.
create or replace function public.delete_payment(p_payment uuid, p_actor uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_payment public.payments%rowtype;
  v_registration public.registrations%rowtype;
  v_approved numeric(10,2);
  v_remaining_payments integer;
  v_pass public.passes%rowtype;
  v_pass_revoked boolean := false;
  v_registration_deleted boolean := false;
begin
  if not exists(select 1 from public.profiles where id=p_actor and role='admin') then
    raise exception 'Administrator access required';
  end if;

  select * into v_payment from public.payments where id=p_payment for update;
  if not found then raise exception 'Payment not found'; end if;

  select * into v_registration from public.registrations
    where id=v_payment.registration_id for update;
  if not found then raise exception 'Registration not found'; end if;

  insert into public.audit_log(actor,action,entity,entity_id,detail)
    values(p_actor,'deleted','payment',v_payment.id::text,
      jsonb_build_object(
        'registration_id',v_payment.registration_id,
        'amount',v_payment.amount,
        'method',v_payment.method,
        'state',v_payment.state,
        'remarks',v_payment.remarks
      ));

  delete from public.payments where id=p_payment;

  if v_payment.state='approved' then
    select coalesce(sum(amount),0) into v_approved from public.payments
      where registration_id=v_registration.id and state='approved';
    if v_approved < v_registration.price then
      delete from public.passes where registration_id=v_registration.id;
      v_pass_revoked := found;
      if v_pass_revoked then
        delete from public.email_outbox where dedupe_key='final:'||v_registration.id::text;
      end if;
    end if;
  end if;

  select count(*) into v_remaining_payments from public.payments
    where registration_id=v_registration.id;
  if v_remaining_payments=0 and v_registration.pay_later_started_at is null then
    select * into v_pass from public.passes where registration_id=v_registration.id for update;
    insert into public.audit_log(actor,action,entity,entity_id,detail)
      values(p_actor,'deleted','registration',v_registration.id::text,
        jsonb_build_object(
          'event_id',v_registration.event_id,
          'member_id',v_registration.member_id,
          'price',v_registration.price,
          'pass_id',v_pass.id,
          'checked_in_at',v_pass.checked_in_at
        ));
    delete from public.passes where registration_id=v_registration.id;
    delete from public.email_outbox
      where dedupe_key in ('final:'||v_registration.id::text,'pay-later:'||v_registration.id::text)
        and sent_at is null;
    delete from public.registrations where id=v_registration.id;
    v_registration_deleted := found;
  end if;

  return jsonb_build_object(
    'paymentId',p_payment,
    'passRevoked',v_pass_revoked,
    'registrationDeleted',v_registration_deleted
  );
end $$;

revoke all on function public.delete_payment(uuid,uuid) from public,anon,authenticated;
grant execute on function public.delete_payment(uuid,uuid) to service_role;
