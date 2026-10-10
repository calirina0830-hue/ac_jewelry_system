begin;

-- ============================================================================
-- Account Management: developer role + all-user activity tracking.
--
-- Adds:
--   1. 'developer' profile role (asiaDeveloper) alongside 'owner' (acOwner).
--      These are the ONLY two special Account Management identities. The old
--      bootstrap usernames asiaCali / ACowner are retired.
--   2. Account Management access is limited to developer + owner. Normal
--      operational roles (admin, staff, viewer) can never enter the area.
--   3. Activity logging opens to every active operational account so admins,
--      staff, and viewers are tracked too, while full log reads stay
--      developer/owner-only.
--
-- Enum safety: every comparison against the NEW enum value 'developer' is a
-- ::text comparison, deferring resolution to runtime so this migration can
-- never fail with 55P04 (unsafe use of new enum value).
-- ============================================================================

alter type public.profile_role add value if not exists 'developer' after 'admin';

comment on type public.profile_role is
  'Authorization roles. developer = system developer; owner = system owner; admin/staff/viewer = operational roles only. Only developer and owner may access Account Management.';

-- ----------------------------------------------------------------------------
-- Role helpers. All new-value comparisons use ::text (55P04-safe).
-- ----------------------------------------------------------------------------

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
      and role::text in ('admin', 'owner', 'developer')
      and is_active
  );
$function$;

-- Gate for Account Management: developer and owner only.
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
      and role::text in ('owner', 'developer')
      and is_active
  );
$function$;

revoke all on function public.is_owner() from public;
grant execute on function public.is_owner() to authenticated;

-- Login identity resolution now also resolves the developer account.
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
    and p.role::text in ('admin', 'owner', 'developer')
    and p.is_active
  limit 1;
$function$;

revoke all on function public.get_login_identity(text) from public;
grant execute on function public.get_login_identity(text) to anon, authenticated;

-- ----------------------------------------------------------------------------
-- Account management RPCs.
-- ----------------------------------------------------------------------------

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

-- Lists every account (all roles) so the Users table can show totals per role.
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
  order by p.created_at asc;
$function$;

revoke all on function public.list_account_management_profiles() from public, anon;
grant execute on function public.list_account_management_profiles()
  to authenticated;

-- Enable/disable stays limited to operational accounts: developer and owner
-- identities cannot be disabled or enabled through Account Management.
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
    and role::text in ('admin', 'staff', 'viewer');

  if not found then
    raise exception 'account_not_found';
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

-- Operational role changes only: no path through Account Management may grant
-- developer or owner. Targets are likewise restricted to operational accounts.
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

  if p_new_role::text not in ('admin', 'staff', 'viewer') then
    raise exception 'invalid_role';
  end if;

  select role into v_old_role
  from public.profiles
  where id = p_user_id
    and role::text in ('admin', 'staff', 'viewer');

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

-- ----------------------------------------------------------------------------
-- Activity tracking for ALL operational users.
--
-- Insert: any active authenticated profile may record its own activity
-- (admins, staff, viewers, owner, developer). Actor identity always comes
-- from the session.
-- Read: users keep read access to their own rows; only developer/owner can
-- read the full trail. No update/delete policies exist: append-only.
-- ----------------------------------------------------------------------------

drop policy if exists "activity_logs_insert_own" on public.admin_activity_logs;

create policy "activity_logs_insert_own"
on public.admin_activity_logs
for insert
to authenticated
with check (
  actor_user_id = (select auth.uid())
  and exists (
    select 1
    from public.profiles
    where id = (select auth.uid())
      and is_active
  )
);

drop policy if exists "activity_logs_select_owner" on public.admin_activity_logs;

create policy "activity_logs_select_owner"
on public.admin_activity_logs
for select
to authenticated
using ((select public.is_owner()));

commit;
