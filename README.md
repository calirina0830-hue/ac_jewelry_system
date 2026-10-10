# AMC Jewelry

AMC Jewelry is a reservation and order management system built with Next.js,
TypeScript, Tailwind CSS, and Supabase. It provides authentication, role-based
customer and stock management, multi-item reservations, status monitoring,
private stock images, and live operational metrics.

## Local setup

1. Install dependencies with npm install.
2. Copy .env.example to .env.local and enter the Supabase project values.
3. Apply the files in supabase/migrations with the Supabase CLI or SQL editor.
4. Add http://localhost:3000/auth/callback to Supabase Auth redirect URLs.
5. Run npm run dev.

## Required environment variables

- NEXT_PUBLIC_SUPABASE_URL
- NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
- NEXT_PUBLIC_SITE_URL
- ADMIN_LOGIN_USERNAME (optional legacy fallback)
- ADMIN_LOGIN_EMAIL (optional legacy fallback)

Only the Supabase publishable key is used. This project does not require or
expose a service-role key.

Sign-in resolves usernames against `profiles.username` through the trusted
`get_login_identity` database function. The ADMIN_LOGIN_* variables remain as
a fallback for deployments that have not assigned a username to their original
administrator yet; once usernames are set they are no longer required.

## Authentication configuration

Enable the Email provider, disable new-user signups, and set the Site URL to the
deployed application origin. Add callback URLs for local development, Vercel
production, and any Vercel preview pattern you intentionally support. Configure
custom SMTP before production because the built-in sender is intended only for
limited testing.

Create the administrator from Supabase Authentication > Users using the email
configured as ADMIN_LOGIN_EMAIL. Set ADMIN_LOGIN_USERNAME to the username shown
on the login form. The password must exist only in Supabase Auth and must never
be placed in an environment variable, migration, or source file.

Promote the trusted operator to admin using a privileged SQL session after
verifying their user ID:

    update public.profiles
    set role = 'admin'
    where id = '<verified-auth-user-uuid>';

Never offer this update through an unprotected browser operation.

## Account management (developer / owner)

Account Management lives at `/account-management` (activity explorer at
`/account-management/activity` and per-user at
`/account-management/<user-id>/activity`). It is outside the dashboard layout,
never linked from the sidebar, and enforced server-side at three layers:

1. The route group layout redirects anyone who is not `developer` or `owner`
   before rendering.
2. Every server action re-checks the profile role against
   `developer` / `owner`.
3. All privileged database functions call `assert_owner_access()` internally,
   and `admin_activity_logs` RLS only allows developer/owner to read all rows.
   The log table has no update or delete grants or policies: audit history is
   append-only for every role.

Roles are `developer`, `owner`, `admin`, `staff`, and `viewer`. Only two
special identities exist — `asiaDeveloper` (role `developer`) and `acOwner`
(role `owner`). They hold every operational capability plus exclusive access to
Account Management. `admin`, `staff`, and `viewer` are operational roles only
and can never enter `/account-management`. Accounts can be disabled
(`profiles.is_active = false`); disabled accounts are refused at sign-in and
signed out on their next request. No UI path can create or grant another
`developer` or `owner`.

First-time setup:

1. Apply all migrations.
2. Create both users manually under Supabase > Authentication > Users with
   their real emails/passwords (migrations never invent passwords).
3. Run `supabase/bootstrap-account-management-accounts.sql` in the SQL editor,
   filling in each auth UUID or email, to promote `asiaDeveloper` to
   `developer` and `acOwner` to `owner`.
4. Sign in on /login and open /account-management to create operational users
   (e.g. Tonyo, Lid, Alnor, Dada) as admin/staff/viewer. New users receive a
   Supabase password-setup email; no passwords ever pass through application
   code, environment variables, or migrations.

Operational activity for ALL users (admins, staff, viewers, owner, developer)
is recorded in `admin_activity_logs` through the trusted `log_admin_activity`
function: actor identity always comes from the session, never from client
arguments. Logs never store passwords, tokens, API keys, cookies, or payment
evidence contents.

## Database and Storage

Apply migrations in filename order. The Phase 2 migration creates customers,
stock_items, their constraints and indexes, role-aware RLS policies, dashboard
metrics, and the private stock-images bucket.

Delivery is stored independently from payment status in `delivered_at`.
Reservation invoices can record partial payments in the existing payment
ledger and save customer-facing notes on the reservation.

Stock images are limited to JPEG, PNG, or WebP and 5 MB. Images are stored under
collision-resistant user-scoped paths and delivered through an authenticated
route. Do not make the stock-images bucket public.

Role behavior:

- admin: read, create, edit, archive, and restore customers and stock
- staff: read, create, and edit active customers and stock
- viewer: read-only access

Invoice, PDF, CSV, and report exports are intentionally reserved for later
phases.
