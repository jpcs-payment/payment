-- Apply after 002 if this project already has the Admin role and you want the
-- developer Admin account to submit payments from its own member workspace.
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
