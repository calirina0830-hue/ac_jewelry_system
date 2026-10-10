begin;

create type public.profile_role as enum ('admin', 'staff', 'viewer');

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null,
  role public.profile_role not null default 'viewer',
  avatar_url text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint profiles_full_name_length
    check (char_length(btrim(full_name)) between 2 and 120),
  constraint profiles_avatar_url_length
    check (avatar_url is null or char_length(avatar_url) <= 2048)
);

comment on table public.profiles is
  'Application profile data linked one-to-one with Supabase Auth users.';
comment on column public.profiles.role is
  'Authorization role. New self-registered accounts receive viewer access.';

create index profiles_role_idx on public.profiles (role);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$function$;

create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  resolved_name text;
begin
  resolved_name := coalesce(
    nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''),
    nullif(split_part(new.email, '@', 1), ''),
    'Bella Jewelry User'
  );

  if char_length(btrim(resolved_name)) < 2 then
    resolved_name := 'Bella Jewelry User';
  end if;

  insert into public.profiles (id, full_name, role)
  values (new.id, left(resolved_name, 120), 'viewer');

  return new;
end;
$function$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_auth_user();

with existing_user_names as (
  select
    id,
    coalesce(
      nullif(btrim(raw_user_meta_data ->> 'full_name'), ''),
      nullif(split_part(email, '@', 1), ''),
      'Bella Jewelry User'
    ) as resolved_name
  from auth.users
)
insert into public.profiles (id, full_name, role)
select
  id,
  case
    when char_length(btrim(resolved_name)) >= 2
      then left(resolved_name, 120)
    else 'Bella Jewelry User'
  end,
  'viewer'
from existing_user_names
on conflict (id) do nothing;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.profiles
    where id = (select auth.uid())
      and role = 'admin'
  );
$function$;

revoke all on table public.profiles from anon, authenticated;
grant select on table public.profiles to authenticated;
grant update (full_name, avatar_url) on table public.profiles to authenticated;
grant usage on type public.profile_role to authenticated;

revoke all on function public.set_updated_at() from public;
revoke all on function public.handle_new_auth_user() from public;
revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

alter table public.profiles enable row level security;

create policy "profiles_select_own"
on public.profiles
for select
to authenticated
using ((select auth.uid()) = id);

create policy "profiles_select_admin"
on public.profiles
for select
to authenticated
using ((select public.is_admin()));

create policy "profiles_update_own"
on public.profiles
for update
to authenticated
using ((select auth.uid()) = id)
with check ((select auth.uid()) = id);

create policy "profiles_update_admin"
on public.profiles
for update
to authenticated
using ((select public.is_admin()))
with check ((select public.is_admin()));

commit;
