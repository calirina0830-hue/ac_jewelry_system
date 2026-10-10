-- ============================================================================
-- One-time bootstrap for the two special Account Management identities.
-- Run in the Supabase SQL editor. NOT applied automatically with migrations.
--
-- Special identities:
--   asiaDeveloper -> role = developer
--   acOwner       -> role = owner
--
-- Prerequisites:
--   1. All migrations applied, including
--      202608210008_developer_role_account_management.sql.
--   2. Both users already exist with their REAL emails/passwords. Create them
--      manually under Supabase > Authentication > Users first. This script
--      NEVER sets or resets passwords; each person sets their own password
--      through the "Forgot password?" flow on /login.
--
-- Match by auth user UUID (preferred) or by exact email. Replace the
-- placeholder UUIDs/emails below, then run. Do not guess UUIDs.
-- ============================================================================

-- 1) Promote asiaDeveloper to the developer role.
update public.profiles p
set username = 'asiaDeveloper',
    role = 'developer',
    is_active = true
from auth.users u
where u.id = p.id
  and (
    u.id = '<asiaDeveloper-auth-uuid>'
    or lower(u.email) = '<asiaDeveloper-email>'
  );

-- 2) Promote acOwner to the owner role.
update public.profiles p
set username = 'acOwner',
    role = 'owner',
    is_active = true
from auth.users u
where u.id = p.id
  and (
    u.id = '<acOwner-auth-uuid>'
    or lower(u.email) = '<acOwner-email>'
  );

-- 3) Verify exactly two special identities exist:
select id, username, full_name, role, is_active
from public.profiles
where role::text in ('developer', 'owner')
order by role::text;

-- Expected: exactly one row with username asiaDeveloper / role developer,
-- and exactly one row with username acOwner / role owner.

-- 4) Optional: assign usernames to existing operational accounts so they can
-- sign in by username. Replace values first.
-- update public.profiles p
-- set username = '<operational-login-username>'
-- from auth.users u
-- where u.id = p.id and lower(u.email) = '<operational-login-email>';
