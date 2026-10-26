-- Reuse the QR already sent for Pay Later when the final payment is approved.
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
  v_reuse_pay_later_qr boolean := false;
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
    select * into v_pass from public.passes where registration_id=v_registration.id for update;
    v_reuse_pay_later_qr:=coalesce(v_pass.pay_later,false);
    insert into public.passes(registration_id,pay_later) values(v_registration.id,false)
      on conflict(registration_id) do update set pay_later=false returning * into v_pass;
    insert into public.email_outbox(dedupe_key,recipient,template,payload)
      values('final:'||v_registration.id::text,v_profile.email,'final_payment',jsonb_build_object(
        'name',v_profile.full_name,'event',v_event.name,'total',v_price,'token',v_pass.token,
        'include_pass_qr',not v_reuse_pay_later_qr
      ))
      on conflict(dedupe_key) do nothing;
  else
    insert into public.email_outbox(dedupe_key,recipient,template,payload)
      values('review:'||v_payment.id::text,v_profile.email,'payment_'||p_decision::text,jsonb_build_object('name',v_profile.full_name,'event',v_event.name,'amount',v_payment.amount,'remarks',p_remarks))
      on conflict(dedupe_key) do nothing;
  end if;
  return jsonb_build_object('payment',to_jsonb(v_payment),'approvedTotal',v_paid,'balance',greatest(0,v_price-v_paid),'fullyPaid',v_paid=v_price,'pass',case when v_paid=v_price then to_jsonb(v_pass) else null end,'reusedPayLaterQr',v_reuse_pay_later_qr);
end $$;

revoke all on function public.review_payment(uuid,uuid,public.payment_state,text) from public,anon,authenticated;
grant execute on function public.review_payment(uuid,uuid,public.payment_state,text) to service_role;
