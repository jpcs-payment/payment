-- Allow 5th Year members
alter table public.profiles drop constraint if exists profiles_year_level_check;
alter table public.profiles add constraint profiles_year_level_check check (year_level between 1 and 5);
