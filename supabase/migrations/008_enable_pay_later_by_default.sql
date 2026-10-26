-- Pay Later is available by default for existing and newly created events.
-- Members still opt in per payment; the member-side checkbox starts unchecked.
alter table public.events
  alter column pay_later_enabled set default true;

update public.events
set pay_later_enabled = true
where pay_later_enabled = false;
