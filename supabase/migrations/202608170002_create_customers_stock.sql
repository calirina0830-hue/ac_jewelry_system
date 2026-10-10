begin;

create or replace function public.current_profile_role()
returns public.profile_role
language sql
stable
security definer
set search_path = ''
as $function$
  select role
  from public.profiles
  where id = (select auth.uid());
$function$;

revoke all on function public.current_profile_role() from public;
grant execute on function public.current_profile_role() to authenticated;

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text,
  phone text,
  address text,
  notes text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  archived_at timestamptz,
  constraint customers_name_length
    check (char_length(btrim(name)) between 2 and 160),
  constraint customers_email_length
    check (email is null or char_length(email) <= 254),
  constraint customers_phone_length
    check (phone is null or char_length(phone) <= 40),
  constraint customers_address_length
    check (address is null or char_length(address) <= 1000),
  constraint customers_notes_length
    check (notes is null or char_length(notes) <= 4000)
);

create index customers_name_lower_idx on public.customers (lower(name));
create index customers_email_lower_idx on public.customers (lower(email));
create index customers_phone_idx on public.customers (phone);
create index customers_archived_at_idx on public.customers (archived_at);
create index customers_created_at_idx on public.customers (created_at desc);
create index customers_created_by_idx on public.customers (created_by);

create trigger customers_set_updated_at
before update on public.customers
for each row execute function public.set_updated_at();

create table public.stock_items (
  id uuid primary key default gen_random_uuid(),
  sku text not null unique,
  name text not null,
  description text,
  category text not null,
  price numeric(12, 2) not null,
  quantity integer not null default 0,
  image_path text,
  is_active boolean not null default true,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  archived_at timestamptz,
  constraint stock_items_sku_length
    check (char_length(btrim(sku)) between 1 and 64),
  constraint stock_items_name_length
    check (char_length(btrim(name)) between 2 and 160),
  constraint stock_items_description_length
    check (description is null or char_length(description) <= 4000),
  constraint stock_items_category_valid
    check (category in (
      'Ring', 'Necklace', 'Bracelet', 'Earrings', 'Pendant',
      'Anklet', 'Watch', 'Set', 'Others'
    )),
  constraint stock_items_price_nonnegative check (price >= 0),
  constraint stock_items_quantity_nonnegative check (quantity >= 0),
  constraint stock_items_image_path_length
    check (image_path is null or char_length(image_path) <= 1024)
);

create index stock_items_name_lower_idx on public.stock_items (lower(name));
create index stock_items_category_idx on public.stock_items (category);
create index stock_items_status_idx
  on public.stock_items (archived_at, is_active);
create index stock_items_quantity_idx on public.stock_items (quantity);
create index stock_items_created_at_idx on public.stock_items (created_at desc);
create index stock_items_created_by_idx on public.stock_items (created_by);

create trigger stock_items_set_updated_at
before update on public.stock_items
for each row execute function public.set_updated_at();

revoke all on table public.customers from anon, authenticated;
revoke all on table public.stock_items from anon, authenticated;
grant select on table public.customers to authenticated;
grant insert (name, email, phone, address, notes, created_by)
  on table public.customers to authenticated;
grant update (name, email, phone, address, notes, archived_at)
  on table public.customers to authenticated;
grant select on table public.stock_items to authenticated;
grant insert (
  sku,
  name,
  description,
  category,
  price,
  quantity,
  image_path,
  is_active,
  created_by
) on table public.stock_items to authenticated;
grant update (
  sku,
  name,
  description,
  category,
  price,
  quantity,
  image_path,
  is_active,
  archived_at
) on table public.stock_items to authenticated;

alter table public.customers enable row level security;
alter table public.stock_items enable row level security;

create policy "customers_select_authenticated"
on public.customers
for select
to authenticated
using (true);

create policy "customers_insert_admin_staff"
on public.customers
for insert
to authenticated
with check (
  (select public.current_profile_role()) in ('admin', 'staff')
  and created_by = (select auth.uid())
  and archived_at is null
);

create policy "customers_update_admin"
on public.customers
for update
to authenticated
using ((select public.current_profile_role()) = 'admin')
with check ((select public.current_profile_role()) = 'admin');

create policy "customers_update_active_staff"
on public.customers
for update
to authenticated
using (
  (select public.current_profile_role()) = 'staff'
  and archived_at is null
)
with check (
  (select public.current_profile_role()) = 'staff'
  and archived_at is null
);

create policy "stock_items_select_authenticated"
on public.stock_items
for select
to authenticated
using (true);

create policy "stock_items_insert_admin_staff"
on public.stock_items
for insert
to authenticated
with check (
  (select public.current_profile_role()) in ('admin', 'staff')
  and created_by = (select auth.uid())
  and archived_at is null
);

create policy "stock_items_update_admin"
on public.stock_items
for update
to authenticated
using ((select public.current_profile_role()) = 'admin')
with check ((select public.current_profile_role()) = 'admin');

create policy "stock_items_update_active_staff"
on public.stock_items
for update
to authenticated
using (
  (select public.current_profile_role()) = 'staff'
  and archived_at is null
)
with check (
  (select public.current_profile_role()) = 'staff'
  and archived_at is null
);

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'stock-images',
  'stock-images',
  false,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy "stock_images_select_authenticated"
on storage.objects
for select
to authenticated
using (bucket_id = 'stock-images');

create policy "stock_images_insert_admin_staff"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'stock-images'
  and (select public.current_profile_role()) in ('admin', 'staff')
  and (storage.foldername(name))[1] = (select auth.uid()::text)
  and lower(storage.extension(name)) in ('jpg', 'png', 'webp')
);

create policy "stock_images_delete_admin_staff"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'stock-images'
  and (select public.current_profile_role()) in ('admin', 'staff')
);

create or replace function public.get_dashboard_metrics()
returns table (
  total_customers bigint,
  active_stock_items bigint,
  total_units bigint,
  low_stock_items bigint
)
language sql
stable
security invoker
set search_path = ''
as $function$
  select
    (
      select count(*)
      from public.customers
      where archived_at is null
    ) as total_customers,
    (
      select count(*)
      from public.stock_items
      where archived_at is null and is_active
    ) as active_stock_items,
    (
      select coalesce(sum(quantity), 0)
      from public.stock_items
      where archived_at is null and is_active
    ) as total_units,
    (
      select count(*)
      from public.stock_items
      where archived_at is null and is_active and quantity <= 5
    ) as low_stock_items;
$function$;

revoke all on function public.get_dashboard_metrics() from public;
grant execute on function public.get_dashboard_metrics() to authenticated;

commit;
