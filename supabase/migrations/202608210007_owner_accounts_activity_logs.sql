begin;

-- ============================================================================
-- Owner / Developer account management + admin activity auditing.
--
-- Adds:
--   1. 'owner' profile role (system owners).
--   2. profiles.username (public login handle) and profiles.is_active
--      (enable/disable switch for accounts).
--   3. public.admin_activity_logs audit table with append-only RLS.
--   4. Trusted security-definer helpers for login identity lookup,
--      activity logging, and owner-only account administration.
--
-- No passwords or secrets are stored or transmitted here. Invited users set
-- their own password through the existing Supabase Auth reset flow.
-- ============================================================================

alter type public.profile_role add value if not exists 'owner' after 'admin';

comment on type public.profile_role is
  'Authorization roles. owner = system owner/developer; admin = trusted operator; staff; viewer.';

-- ----------------------------------------------------------------------------
-- profiles: username + is_active
-- ----------------------------------------------------------------------------

alter table public.profiles
  add column if not exists username text;

alter table public.profiles
  add column if not exists is_active boolean not null default true;

create unique index if not exists profiles_username_key
  on public.profiles (lower(username))
  where username is not null;

create index if not exists profiles_is_active_idx
  on public.profiles (is_active);

alter table public.profiles drop constraint if exists profiles_username_format;

alter table public.profiles
  add constraint profiles_username_format
  check (
    username is null
    or (
      char_length(btrim(username)) between 2 and 64
      and username ~ '^[a-zA-Z0-9._-]+$'
    )
  );

comment on column public.profiles.username is
  'Public login handle shown on the sign-in form. Null until assigned.';
comment on column public.profiles.is_active is
  'False disables the account: sign-in and app access are refused.';

-- New auth users may carry full_name/username in raw_user_meta_data so that
-- owner-created accounts receive a complete profile immediately.
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  resolved_name text;
  resolved_username text;
begin
  resolved_name := coalesce(
    nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''),
    nullif(split_part(new.email, '@', 1), ''),
    'AC Pearl and Jewelries User'
  );

  if char_length(btrim(resolved_name)) < 2 then
    resolved_name := 'AC Pearl and Jewelries User';
  end if;

  resolved_username := nullif(btrim(new.raw_user_meta_data ->> 'username'), '');

  insert into public.profiles (id, full_name, role, username)
  values (
    new.id,
    left(resolved_name, 120),
    'viewer',
    left(resolved_username, 64)
  );

  return new;
end;
$function$;

-- Owners keep every capability admins have across the application.
--
-- NOTE: every comparison against the NEW enum value 'owner' is written as a
-- ::text comparison. PostgreSQL forbids referencing a freshly added enum
-- value inside the same transaction (55P04), and SQL-function bodies are
-- parsed at CREATE time. Text comparisons defer resolution to runtime.
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
      and role::text in ('admin', 'owner')
      and is_active
  );
$function$;

create or replace function public.is_owner()
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
      and role::text = 'owner'
      and is_active
  );
$function$;

revoke all on function public.is_owner() from public;
grant execute on function public.is_owner() to authenticated;

-- ----------------------------------------------------------------------------
-- Owner-aware profile policies (existing policies are preserved).
-- ----------------------------------------------------------------------------

drop policy if exists "profiles_select_owner" on public.profiles;

create policy "profiles_select_owner"
on public.profiles
for select
to authenticated
using ((select public.is_owner()));

-- ----------------------------------------------------------------------------
-- Admin activity log (append-only)
-- ----------------------------------------------------------------------------

create table if not exists public.admin_activity_logs (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references auth.users (id) on delete set null,
  actor_username text,
  actor_display_name text,
  action text not null,
  entity_type text,
  entity_id text,
  description text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  constraint admin_activity_logs_action_length
    check (char_length(btrim(action)) between 1 and 100),
  constraint admin_activity_logs_entity_type_length
    check (entity_type is null or char_length(entity_type) <= 60),
  constraint admin_activity_logs_description_length
    check (description is null or char_length(description) <= 500),
  constraint admin_activity_logs_metadata_size
    check (pg_column_size(metadata) <= 4096)
);

comment on table public.admin_activity_logs is
  'Append-only operational audit trail. Never stores passwords, tokens, keys, or file contents.';

create index if not exists admin_activity_logs_created_at_idx
  on public.admin_activity_logs (created_at desc);

create index if not exists admin_activity_logs_actor_created_idx
  on public.admin_activity_logs (actor_user_id, created_at desc);

create index if not exists admin_activity_logs_action_idx
  on public.admin_activity_logs (action);

create index if not exists admin_activity_logs_entity_idx
  on public.admin_activity_logs (entity_type, entity_id);

revoke all on table public.admin_activity_logs from anon, authenticated;
grant insert on table public.admin_activity_logs to authenticated;
grant select on table public.admin_activity_logs to authenticated;
grant usage on schema public to anon, authenticated;

alter table public.admin_activity_logs enable row level security;

drop policy if exists "activity_logs_insert_own" on public.admin_activity_logs;

create policy "activity_logs_insert_own"
on public.admin_activity_logs
for insert
to authenticated
with check (
  actor_user_id = (select auth.uid())
  and (select public.is_admin())
);

drop policy if exists "activity_logs_select_own" on public.admin_activity_logs;

create policy "activity_logs_select_own"
on public.admin_activity_logs
for select
to authenticated
using (actor_user_id = (select auth.uid()));

drop policy if exists "activity_logs_select_owner" on public.admin_activity_logs;

create policy "activity_logs_select_owner"
on public.admin_activity_logs
for select
to authenticated
using ((select public.is_owner()));

-- Intentionally NO update/delete policies or grants: audit history is
-- immutable for every role, including owners.

-- Trusted logging entry point. Actor identity always comes from the session,
-- never from client arguments.
create or replace function public.log_admin_activity(
  p_action text,
  p_entity_type text default null,
  p_entity_id text default null,
  p_description text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor uuid := (select auth.uid());
  v_profile record;
begin
  if v_actor is null then
    raise insufficient_privilege;
  end if;

  select username, full_name into v_profile
  from public.profiles
  where id = v_actor
    and is_active;

  if not found then
    raise insufficient_privilege;
  end if;

  insert into public.admin_activity_logs (
    actor_user_id,
    actor_username,
    actor_display_name,
    action,
    entity_type,
    entity_id,
    description,
    metadata
  ) values (
    v_actor,
    v_profile.username,
    v_profile.full_name,
    left(btrim(p_action), 100),
    left(p_entity_type, 60),
    p_entity_id,
    left(p_description, 500),
    p_metadata
  );
end;
$function$;

revoke all on function public.log_admin_activity(text, text, text, text, jsonb)
  from public, anon;
grant execute on function public.log_admin_activity(text, text, text, text, jsonb)
  to authenticated;

-- ----------------------------------------------------------------------------
-- Login identity resolution (username -> auth email), used by the sign-in
-- server action. Only active admin/owner accounts resolve.
-- ----------------------------------------------------------------------------

create or replace function public.get_login_identity(p_username text)
returns table (
  user_id uuid,
  email text,
  role public.profile_role,
  is_active boolean
)
language sql
stable
security definer
set search_path = ''
as $function$
  select
    p.id,
    u.email,
    p.role,
    p.is_active
  from public.profiles p
  join auth.users u on u.id = p.id
  where lower(p.username) = lower(btrim(p_username))
    and p.role::text in ('admin', 'owner')
    and p.is_active
  limit 1;
$function$;

revoke all on function public.get_login_identity(text) from public;
grant execute on function public.get_login_identity(text) to anon, authenticated;

-- ----------------------------------------------------------------------------
-- Account management RPCs (each re-checks ownership internally so the rules
-- hold regardless of how they are invoked).
-- ----------------------------------------------------------------------------

create or replace function public.list_account_management_profiles()
returns table (
  id uuid,
  username text,
  full_name text,
  email text,
  role public.profile_role,
  is_active boolean,
  created_at timestamptz,
  last_login_at timestamptz,
  last_activity_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $function$
  select
    p.id,
    p.username,
    p.full_name,
    u.email,
    p.role,
    p.is_active,
    p.created_at,
    u.last_sign_in_at,
    (select max(l.created_at)
     from public.admin_activity_logs l
     where l.actor_user_id = p.id)
  from public.profiles p
  join auth.users u on u.id = p.id
  where p.role::text in ('admin', 'owner')
  order by p.created_at asc;
$function$;

revoke all on function public.list_account_management_profiles() from public, anon;
grant execute on function public.list_account_management_profiles()
  to authenticated;

create or replace function public.assert_owner_access()
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if not coalesce((select public.is_owner()), false) then
    raise insufficient_privilege using message = 'owner_only';
  end if;
end;
$function$;

revoke all on function public.assert_owner_access() from public, anon;
grant execute on function public.assert_owner_access() to authenticated;

create or replace function public.set_account_status(
  p_user_id uuid,
  p_is_active boolean
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
begin
  perform public.assert_owner_access();

  if p_user_id = (select auth.uid()) then
    raise exception 'self_change_forbidden';
  end if;

  update public.profiles
  set is_active = p_is_active
  where id = p_user_id
    and role in ('admin', 'staff', 'viewer');

  if not found then
    raise exception 'account_not_found';
  end if;

  -- Log through the definer path because the caller's own-row insert policy
  -- still applies; this row records an owner administrative action.
  insert into public.admin_activity_logs (
    actor_user_id,
    actor_username,
    actor_display_name,
    action,
    entity_type,
    entity_id,
    description,
    metadata
  )
  select
    (select auth.uid()),
    o.username,
    o.full_name,
    case when p_is_active then 'account_activated' else 'account_disabled' end,
    'account',
    p.id::text,
    (case when p_is_active then 'Activated' else 'Disabled' end)
      || ' account ' || coalesce(p.username, u.email),
    jsonb_build_object('target_role', p.role)
  from public.profiles p
  join auth.users u on u.id = p.id
  where p.id = p_user_id
    and (select auth.uid()) is not null
    and exists (
      select 1 from public.profiles o
      where o.id = (select auth.uid())
    );

  return true;
end;
$function$;

revoke all on function public.set_account_status(uuid, boolean)
  from public, anon;
grant execute on function public.set_account_status(uuid, boolean)
  to authenticated;

create or replace function public.set_account_role(
  p_user_id uuid,
  p_new_role public.profile_role
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_old_role public.profile_role;
begin
  perform public.assert_owner_access();

  if p_user_id = (select auth.uid()) then
    raise exception 'self_change_forbidden';
  end if;

  if p_new_role::text not in ('admin', 'staff', 'viewer', 'owner') then
    raise exception 'invalid_role';
  end if;

  select role into v_old_role
  from public.profiles
  where id = p_user_id;

  if not found then
    raise exception 'account_not_found';
  end if;

  update public.profiles
  set role = p_new_role
  where id = p_user_id;

  insert into public.admin_activity_logs (
    actor_user_id,
    actor_username,
    actor_display_name,
    action,
    entity_type,
    entity_id,
    description,
    metadata
  )
  select
    c.actor_id,
    c.actor_username,
    c.actor_name,
    'account_role_changed',
    'account',
    p_user_id::text,
    'Changed role of ' || coalesce(t.username, u.email)
      || ' from ' || v_old_role || ' to ' || p_new_role,
    jsonb_build_object('old_role', v_old_role, 'new_role', p_new_role)
  from (
    select
      (select auth.uid()) as actor_id,
      o.username as actor_username,
      o.full_name as actor_name
    from public.profiles o
    where o.id = (select auth.uid())
  ) c
  join public.profiles t on t.id = p_user_id
  join auth.users u on u.id = p_user_id
  where c.actor_id is not null;

  return true;
end;
$function$;

revoke all on function public.set_account_role(uuid, public.profile_role)
  from public, anon;
grant execute on function public.set_account_role(uuid, public.profile_role)
  to authenticated;

-- Creates an authentication user without any password knowledge in this code
-- base. The account starts with an unguessable random password; the inviting
-- owner then triggers Supabase Auth's password-reset email so the invitee can
-- set their own credentials.
create or replace function public.create_admin_account(
  p_username text,
  p_email text,
  p_full_name text,
  p_role public.profile_role
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_clean_username text := btrim(p_username);
  v_clean_email text := lower(btrim(p_email));
  v_clean_name text := btrim(p_full_name);
  v_user_id uuid;
  v_random_secret text;
begin
  perform public.assert_owner_access();

  if v_clean_username !~ '^[a-zA-Z0-9._-]{2,64}$' then
    raise exception 'invalid_username';
  end if;

  if v_clean_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    or char_length(v_clean_email) > 254 then
    raise exception 'invalid_email';
  end if;

  if char_length(v_clean_name) < 2 or char_length(v_clean_name) > 120 then
    raise exception 'invalid_full_name';
  end if;

  if p_role not in ('admin', 'staff', 'viewer') then
    raise exception 'invalid_role';
  end if;

  if exists (
    select 1 from public.profiles
    where lower(username) = lower(v_clean_username)
  ) then
    raise exception 'username_taken';
  end if;

  if exists (
    select 1 from auth.users u where lower(u.email) = v_clean_email
  ) then
    raise exception 'email_taken';
  end if;

  v_user_id := gen_random_uuid();
  v_random_secret :=
    encode(gen_random_bytes(32), 'hex')
    || encode(gen_random_bytes(32), 'hex');

  insert into auth.users (
    instance_id,
    id,
    aud,
    role,
    email,
    encrypted_password,
    email_confirmed_at,
    raw_app_meta_data,
    raw_user_meta_data,
    created_at,
    updated_at,
    confirmation_token,
    recovery_token,
    email_change_token_new,
    email_change
  ) values (
    '00000000-0000-0000-0000-000000000000',
    v_user_id,
    'authenticated',
    'authenticated',
    v_clean_email,
    crypt(v_random_secret, gen_salt('bf', 12)),
    timezone('utc', now()),
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object(
      'full_name', left(v_clean_name, 120),
      'username', v_clean_username
    ),
    timezone('utc', now()),
    timezone('utc', now()),
    '',
    '',
    '',
    ''
  );

  insert into auth.identities (
    id,
    user_id,
    provider_id,
    identity_data,
    provider,
    last_sign_in_at,
    created_at,
    updated_at
  ) values (
    gen_random_uuid(),
    v_user_id,
    v_user_id::text,
    jsonb_build_object(
      'sub', v_user_id::text,
      'email', v_clean_email,
      'email_verified', true
    ),
    'email',
    timezone('utc', now()),
    timezone('utc', now()),
    timezone('utc', now())
  );

  -- The on_auth_user_created trigger already created the profile; align its
  -- role and username with the invitation.
  update public.profiles
  set role = p_role,
      username = v_clean_username
  where id = v_user_id;

  insert into public.admin_activity_logs (
    actor_user_id,
    actor_username,
    actor_display_name,
    action,
    entity_type,
    entity_id,
    description,
    metadata
  )
  select
    o.id,
    o.username,
    o.full_name,
    'account_created',
    'account',
    v_user_id::text,
    'Created account ' || v_clean_username || ' (' || v_clean_email || ') as '
      || p_role,
    jsonb_build_object('new_role', p_role)
  from public.profiles o
  where o.id = (select auth.uid());

  return v_user_id;
end;
$function$;

revoke all on function public.create_admin_account(text, text, text, public.profile_role)
  from public, anon;
grant execute on function public.create_admin_account(text, text, text, public.profile_role)
  to authenticated;

commit;
