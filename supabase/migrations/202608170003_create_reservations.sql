begin;

create sequence public.reservation_number_seq as bigint start with 1 increment by 1;

create or replace function public.next_reservation_number()
returns text
language sql
volatile
security definer
set search_path = ''
as $function$
  select
    'RES-' ||
    to_char(timezone('Asia/Manila', now()), 'YYYY') ||
    '-' ||
    lpad(nextval('public.reservation_number_seq')::text, 6, '0');
$function$;

revoke all on sequence public.reservation_number_seq from public, anon, authenticated;
revoke all on function public.next_reservation_number() from public, anon, authenticated;

create table public.reservations (
  id uuid primary key default gen_random_uuid(),
  reservation_no text not null unique default public.next_reservation_number(),
  customer_id uuid not null references public.customers (id) on delete restrict,
  status text not null default 'reserved',
  subtotal numeric(12, 2) not null,
  discount numeric(12, 2) not null default 0,
  downpayment numeric(12, 2) not null default 0,
  total numeric(12, 2) not null,
  balance numeric(12, 2) not null,
  notes text,
  reserved_at timestamptz not null default timezone('utc', now()),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  archived_at timestamptz,
  constraint reservations_number_format
    check (reservation_no ~ '^RES-[0-9]{4}-[0-9]{6,}$'),
  constraint reservations_status_valid
    check (status in ('reserved', 'paid', 'delivered', 'cancelled')),
  constraint reservations_subtotal_nonnegative check (subtotal >= 0),
  constraint reservations_discount_nonnegative check (discount >= 0),
  constraint reservations_downpayment_nonnegative check (downpayment >= 0),
  constraint reservations_total_nonnegative check (total >= 0),
  constraint reservations_balance_nonnegative check (balance >= 0),
  constraint reservations_discount_within_subtotal check (discount <= subtotal),
  constraint reservations_downpayment_within_total check (downpayment <= total),
  constraint reservations_total_consistent check (total = subtotal - discount),
  constraint reservations_balance_consistent check (balance = total - downpayment),
  constraint reservations_notes_length
    check (notes is null or char_length(notes) <= 4000)
);

create table public.reservation_items (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null
    references public.reservations (id) on delete cascade,
  stock_item_id uuid not null references public.stock_items (id) on delete restrict,
  item_name text not null,
  sku text not null,
  quantity integer not null,
  unit_price numeric(12, 2) not null,
  discount numeric(12, 2) not null default 0,
  line_total numeric(12, 2) not null,
  image_path text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint reservation_items_one_stock_per_reservation
    unique (reservation_id, stock_item_id),
  constraint reservation_items_name_length
    check (char_length(btrim(item_name)) between 1 and 160),
  constraint reservation_items_sku_length
    check (char_length(btrim(sku)) between 1 and 64),
  constraint reservation_items_quantity_positive check (quantity > 0),
  constraint reservation_items_unit_price_nonnegative check (unit_price >= 0),
  constraint reservation_items_discount_nonnegative check (discount >= 0),
  constraint reservation_items_line_total_nonnegative check (line_total >= 0),
  constraint reservation_items_discount_within_line
    check (discount <= unit_price * quantity),
  constraint reservation_items_line_total_consistent
    check (line_total = (unit_price * quantity) - discount),
  constraint reservation_items_image_path_length
    check (image_path is null or char_length(image_path) <= 1024)
);

create index reservations_customer_id_idx on public.reservations (customer_id);
create index reservations_status_idx on public.reservations (status);
create index reservations_archived_at_idx on public.reservations (archived_at);
create index reservations_reserved_at_idx on public.reservations (reserved_at desc);
create index reservations_created_by_idx on public.reservations (created_by);
create index reservation_items_reservation_id_idx
  on public.reservation_items (reservation_id);
create index reservation_items_stock_item_id_idx
  on public.reservation_items (stock_item_id);

create trigger reservations_set_updated_at
before update on public.reservations
for each row execute function public.set_updated_at();

create trigger reservation_items_set_updated_at
before update on public.reservation_items
for each row execute function public.set_updated_at();

revoke all on table public.reservations from anon, authenticated;
revoke all on table public.reservation_items from anon, authenticated;
grant select on table public.reservations to authenticated;
grant select on table public.reservation_items to authenticated;

alter table public.reservations enable row level security;
alter table public.reservation_items enable row level security;

create policy "reservations_select_authenticated"
on public.reservations
for select
to authenticated
using (true);

create policy "reservations_insert_admin_staff"
on public.reservations
for insert
to authenticated
with check (
  (select public.current_profile_role()) in ('admin', 'staff')
  and created_by = (select auth.uid())
  and status = 'reserved'
  and archived_at is null
);

create policy "reservations_update_admin"
on public.reservations
for update
to authenticated
using ((select public.current_profile_role()) = 'admin')
with check ((select public.current_profile_role()) = 'admin');

create policy "reservations_update_active_staff"
on public.reservations
for update
to authenticated
using (
  (select public.current_profile_role()) = 'staff'
  and status = 'reserved'
  and archived_at is null
)
with check (
  (select public.current_profile_role()) = 'staff'
  and status = 'reserved'
  and archived_at is null
);

create policy "reservation_items_select_authenticated"
on public.reservation_items
for select
to authenticated
using (true);

create policy "reservation_items_insert_admin_staff"
on public.reservation_items
for insert
to authenticated
with check (
  (select public.current_profile_role()) in ('admin', 'staff')
  and exists (
    select 1
    from public.reservations
    where id = reservation_id
      and status = 'reserved'
      and archived_at is null
  )
);

create policy "reservation_items_update_admin_staff"
on public.reservation_items
for update
to authenticated
using (
  (select public.current_profile_role()) in ('admin', 'staff')
  and exists (
    select 1
    from public.reservations
    where id = reservation_id
      and status = 'reserved'
      and archived_at is null
  )
)
with check (
  (select public.current_profile_role()) in ('admin', 'staff')
  and exists (
    select 1
    from public.reservations
    where id = reservation_id
      and status = 'reserved'
      and archived_at is null
  )
);

create policy "reservation_items_delete_admin_staff"
on public.reservation_items
for delete
to authenticated
using (
  (select public.current_profile_role()) in ('admin', 'staff')
  and exists (
    select 1
    from public.reservations
    where id = reservation_id
      and status = 'reserved'
      and archived_at is null
  )
);

create or replace function public.prepare_reservation_items(
  p_items jsonb,
  p_exclude_reservation_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_input jsonb;
  v_stock public.stock_items%rowtype;
  v_existing public.reservation_items%rowtype;
  v_stock_id uuid;
  v_item_id uuid;
  v_quantity integer;
  v_discount numeric;
  v_unit_price numeric(12, 2);
  v_line_total numeric(12, 2);
  v_subtotal numeric := 0;
  v_held integer;
  v_available integer;
  v_seen_stock_ids uuid[] := array[]::uuid[];
  v_prepared_items jsonb := '[]'::jsonb;
  v_item_name text;
  v_sku text;
  v_image_path text;
begin
  if jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) < 1
     or jsonb_array_length(p_items) > 50 then
    raise exception 'invalid_reservation_items' using errcode = 'P0001';
  end if;

  begin
    perform stock.id
    from public.stock_items as stock
    where stock.id in (
      select (item.value ->> 'stock_item_id')::uuid
      from jsonb_array_elements(p_items) as item(value)
    )
    order by stock.id
    for update;
  exception
    when invalid_text_representation then
      raise exception 'invalid_reservation_items' using errcode = 'P0001';
  end;

  for v_input in
    select item.value
    from jsonb_array_elements(p_items) with ordinality as item(value, position)
    order by item.position
  loop
    if jsonb_typeof(v_input) <> 'object' then
      raise exception 'invalid_reservation_items' using errcode = 'P0001';
    end if;

    begin
      v_stock_id := nullif(v_input ->> 'stock_item_id', '')::uuid;
      v_item_id := nullif(v_input ->> 'reservation_item_id', '')::uuid;
      v_quantity := (v_input ->> 'quantity')::integer;
      v_discount := (v_input ->> 'discount')::numeric;
    exception
      when invalid_text_representation or numeric_value_out_of_range then
        raise exception 'invalid_reservation_items' using errcode = 'P0001';
    end;

    if v_stock_id is null
       or v_quantity is null
       or v_quantity <= 0
       or v_discount is null
       or v_discount = 'NaN'::numeric
       or v_discount < 0
       or v_discount > 9999999999.99
       or v_discount <> round(v_discount, 2) then
      raise exception 'invalid_reservation_items' using errcode = 'P0001';
    end if;

    if v_stock_id = any(v_seen_stock_ids) then
      raise exception 'duplicate_stock_item' using errcode = 'P0001';
    end if;
    v_seen_stock_ids := array_append(v_seen_stock_ids, v_stock_id);

    select stock.*
    into v_stock
    from public.stock_items as stock
    where stock.id = v_stock_id;

    if not found
       or not v_stock.is_active
       or v_stock.archived_at is not null then
      raise exception 'stock_item_unavailable:%', v_stock_id using errcode = 'P0001';
    end if;

    select coalesce(sum(items.quantity), 0)::integer
    into v_held
    from public.reservation_items as items
    join public.reservations as reservation
      on reservation.id = items.reservation_id
    where items.stock_item_id = v_stock_id
      and reservation.status = 'reserved'
      and reservation.archived_at is null
      and (
        p_exclude_reservation_id is null
        or reservation.id <> p_exclude_reservation_id
      );

    v_available := greatest(v_stock.quantity - v_held, 0);

    if v_quantity > v_available then
      raise exception 'insufficient_stock:%:%', v_stock_id, v_available
        using errcode = 'P0001';
    end if;

    if v_item_id is not null then
      if p_exclude_reservation_id is null then
        raise exception 'invalid_reservation_item_reference' using errcode = 'P0001';
      end if;

      select items.*
      into v_existing
      from public.reservation_items as items
      where items.id = v_item_id
        and items.reservation_id = p_exclude_reservation_id
        and items.stock_item_id = v_stock_id;

      if not found then
        raise exception 'invalid_reservation_item_reference' using errcode = 'P0001';
      end if;

      v_unit_price := v_existing.unit_price;
      v_item_name := v_existing.item_name;
      v_sku := v_existing.sku;
      v_image_path := v_existing.image_path;
    else
      v_item_id := gen_random_uuid();
      v_unit_price := v_stock.price;
      v_item_name := v_stock.name;
      v_sku := v_stock.sku;
      v_image_path := v_stock.image_path;
    end if;

    v_line_total := (v_unit_price * v_quantity) - v_discount;

    if v_discount > v_unit_price * v_quantity or v_line_total < 0 then
      raise exception 'line_discount_exceeds_subtotal:%', v_stock_id
        using errcode = 'P0001';
    end if;

    if v_line_total > 9999999999.99 then
      raise exception 'reservation_total_too_large' using errcode = 'P0001';
    end if;

    v_subtotal := v_subtotal + v_line_total;
    v_prepared_items := v_prepared_items || jsonb_build_array(
      jsonb_build_object(
        'id', v_item_id,
        'stock_item_id', v_stock_id,
        'item_name', v_item_name,
        'sku', v_sku,
        'quantity', v_quantity,
        'unit_price', v_unit_price,
        'discount', v_discount,
        'line_total', v_line_total,
        'image_path', v_image_path
      )
    );
  end loop;

  if v_subtotal > 9999999999.99 then
    raise exception 'reservation_total_too_large' using errcode = 'P0001';
  end if;

  return jsonb_build_object(
    'items', v_prepared_items,
    'subtotal', v_subtotal
  );
end;
$function$;

revoke all on function public.prepare_reservation_items(jsonb, uuid)
  from public, anon, authenticated;

create or replace function public.create_reservation(
  p_customer_id uuid,
  p_discount numeric,
  p_downpayment numeric,
  p_notes text,
  p_items jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_prepared jsonb;
  v_subtotal numeric(12, 2);
  v_total numeric(12, 2);
  v_reservation_id uuid;
begin
  if v_user_id is null
     or public.current_profile_role() not in ('admin', 'staff') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  perform 1
  from public.customers as customer
  where customer.id = p_customer_id
    and customer.archived_at is null
  for share;

  if not found then
    raise exception 'customer_unavailable' using errcode = 'P0001';
  end if;

  if p_discount is null
     or p_downpayment is null
     or p_discount = 'NaN'::numeric
     or p_downpayment = 'NaN'::numeric
     or p_discount < 0
     or p_downpayment < 0
     or p_discount > 9999999999.99
     or p_downpayment > 9999999999.99
     or p_discount <> round(p_discount, 2)
     or p_downpayment <> round(p_downpayment, 2)
     or char_length(coalesce(p_notes, '')) > 4000 then
    raise exception 'invalid_reservation_totals' using errcode = 'P0001';
  end if;

  v_prepared := public.prepare_reservation_items(p_items, null);
  v_subtotal := (v_prepared ->> 'subtotal')::numeric;

  if p_discount > v_subtotal then
    raise exception 'reservation_discount_exceeds_subtotal' using errcode = 'P0001';
  end if;

  v_total := v_subtotal - p_discount;

  if p_downpayment > v_total then
    raise exception 'downpayment_exceeds_total' using errcode = 'P0001';
  end if;

  insert into public.reservations (
    customer_id,
    status,
    subtotal,
    discount,
    downpayment,
    total,
    balance,
    notes,
    created_by
  )
  values (
    p_customer_id,
    'reserved',
    v_subtotal,
    p_discount,
    p_downpayment,
    v_total,
    v_total - p_downpayment,
    nullif(btrim(p_notes), ''),
    v_user_id
  )
  returning id into v_reservation_id;

  insert into public.reservation_items (
    id,
    reservation_id,
    stock_item_id,
    item_name,
    sku,
    quantity,
    unit_price,
    discount,
    line_total,
    image_path
  )
  select
    prepared.id,
    v_reservation_id,
    prepared.stock_item_id,
    prepared.item_name,
    prepared.sku,
    prepared.quantity,
    prepared.unit_price,
    prepared.discount,
    prepared.line_total,
    prepared.image_path
  from jsonb_to_recordset(v_prepared -> 'items') as prepared(
    id uuid,
    stock_item_id uuid,
    item_name text,
    sku text,
    quantity integer,
    unit_price numeric,
    discount numeric,
    line_total numeric,
    image_path text
  );

  return v_reservation_id;
end;
$function$;

create or replace function public.update_reservation(
  p_reservation_id uuid,
  p_expected_updated_at timestamptz,
  p_customer_id uuid,
  p_discount numeric,
  p_downpayment numeric,
  p_notes text,
  p_items jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_reservation public.reservations%rowtype;
  v_prepared jsonb;
  v_subtotal numeric(12, 2);
  v_total numeric(12, 2);
begin
  if v_user_id is null
     or public.current_profile_role() not in ('admin', 'staff') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  select reservation.*
  into v_reservation
  from public.reservations as reservation
  where reservation.id = p_reservation_id
  for update;

  if not found then
    raise exception 'reservation_not_found' using errcode = 'P0001';
  end if;

  if v_reservation.archived_at is not null or v_reservation.status <> 'reserved' then
    raise exception 'reservation_not_editable' using errcode = 'P0001';
  end if;

  if v_reservation.updated_at is distinct from p_expected_updated_at then
    raise exception 'stale_reservation' using errcode = 'P0001';
  end if;

  perform 1
  from public.customers as customer
  where customer.id = p_customer_id
    and customer.archived_at is null
  for share;

  if not found then
    raise exception 'customer_unavailable' using errcode = 'P0001';
  end if;

  if p_discount is null
     or p_downpayment is null
     or p_discount = 'NaN'::numeric
     or p_downpayment = 'NaN'::numeric
     or p_discount < 0
     or p_downpayment < 0
     or p_discount > 9999999999.99
     or p_downpayment > 9999999999.99
     or p_discount <> round(p_discount, 2)
     or p_downpayment <> round(p_downpayment, 2)
     or char_length(coalesce(p_notes, '')) > 4000 then
    raise exception 'invalid_reservation_totals' using errcode = 'P0001';
  end if;

  v_prepared := public.prepare_reservation_items(
    p_items,
    p_reservation_id
  );
  v_subtotal := (v_prepared ->> 'subtotal')::numeric;

  if p_discount > v_subtotal then
    raise exception 'reservation_discount_exceeds_subtotal' using errcode = 'P0001';
  end if;

  v_total := v_subtotal - p_discount;

  if p_downpayment > v_total then
    raise exception 'downpayment_exceeds_total' using errcode = 'P0001';
  end if;

  update public.reservations
  set
    customer_id = p_customer_id,
    subtotal = v_subtotal,
    discount = p_discount,
    downpayment = p_downpayment,
    total = v_total,
    balance = v_total - p_downpayment,
    notes = nullif(btrim(p_notes), '')
  where id = p_reservation_id;

  delete from public.reservation_items
  where reservation_id = p_reservation_id;

  insert into public.reservation_items (
    id,
    reservation_id,
    stock_item_id,
    item_name,
    sku,
    quantity,
    unit_price,
    discount,
    line_total,
    image_path
  )
  select
    prepared.id,
    p_reservation_id,
    prepared.stock_item_id,
    prepared.item_name,
    prepared.sku,
    prepared.quantity,
    prepared.unit_price,
    prepared.discount,
    prepared.line_total,
    prepared.image_path
  from jsonb_to_recordset(v_prepared -> 'items') as prepared(
    id uuid,
    stock_item_id uuid,
    item_name text,
    sku text,
    quantity integer,
    unit_price numeric,
    discount numeric,
    line_total numeric,
    image_path text
  );

  return p_reservation_id;
end;
$function$;

revoke all on function public.create_reservation(uuid, numeric, numeric, text, jsonb)
  from public, anon;
revoke all on function public.update_reservation(uuid, timestamptz, uuid, numeric, numeric, text, jsonb)
  from public, anon;
grant execute on function public.create_reservation(uuid, numeric, numeric, text, jsonb)
  to authenticated;
grant execute on function public.update_reservation(uuid, timestamptz, uuid, numeric, numeric, text, jsonb)
  to authenticated;

create or replace function public.archive_reservation(p_reservation_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_reservation public.reservations%rowtype;
begin
  if auth.uid() is null or public.current_profile_role() <> 'admin' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  select reservation.*
  into v_reservation
  from public.reservations as reservation
  where reservation.id = p_reservation_id
  for update;

  if not found then
    raise exception 'reservation_not_found' using errcode = 'P0001';
  end if;

  if v_reservation.status <> 'reserved' then
    raise exception 'reservation_not_archivable' using errcode = 'P0001';
  end if;

  if v_reservation.archived_at is null then
    update public.reservations
    set archived_at = timezone('utc', now())
    where id = p_reservation_id;
  end if;

  return true;
end;
$function$;

create or replace function public.restore_reservation(p_reservation_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_reservation public.reservations%rowtype;
  v_item record;
  v_held integer;
  v_available integer;
begin
  if auth.uid() is null or public.current_profile_role() <> 'admin' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  select reservation.*
  into v_reservation
  from public.reservations as reservation
  where reservation.id = p_reservation_id
  for update;

  if not found then
    raise exception 'reservation_not_found' using errcode = 'P0001';
  end if;

  if v_reservation.archived_at is null then
    return true;
  end if;

  if v_reservation.status <> 'reserved' then
    raise exception 'reservation_not_restorable' using errcode = 'P0001';
  end if;

  perform stock.id
  from public.stock_items as stock
  join public.reservation_items as items
    on items.stock_item_id = stock.id
  where items.reservation_id = p_reservation_id
  order by stock.id
  for update;

  for v_item in
    select
      stock.id as stock_item_id,
      stock.quantity,
      stock.is_active,
      stock.archived_at,
      sum(items.quantity)::integer as requested_quantity
    from public.reservation_items as items
    join public.stock_items as stock
      on stock.id = items.stock_item_id
    where items.reservation_id = p_reservation_id
    group by stock.id, stock.quantity, stock.is_active, stock.archived_at
  loop
    if not v_item.is_active or v_item.archived_at is not null then
      raise exception 'stock_item_unavailable:%', v_item.stock_item_id
        using errcode = 'P0001';
    end if;

    select coalesce(sum(items.quantity), 0)::integer
    into v_held
    from public.reservation_items as items
    join public.reservations as reservation
      on reservation.id = items.reservation_id
    where items.stock_item_id = v_item.stock_item_id
      and reservation.status = 'reserved'
      and reservation.archived_at is null
      and reservation.id <> p_reservation_id;

    v_available := greatest(v_item.quantity - v_held, 0);

    if v_item.requested_quantity > v_available then
      raise exception 'insufficient_stock:%:%', v_item.stock_item_id, v_available
        using errcode = 'P0001';
    end if;
  end loop;

  update public.reservations
  set archived_at = null
  where id = p_reservation_id;

  return true;
end;
$function$;

revoke all on function public.archive_reservation(uuid) from public, anon;
revoke all on function public.restore_reservation(uuid) from public, anon;
grant execute on function public.archive_reservation(uuid) to authenticated;
grant execute on function public.restore_reservation(uuid) to authenticated;

create or replace function public.get_reservable_stock(
  p_exclude_reservation_id uuid default null
)
returns table (
  id uuid,
  sku text,
  name text,
  price numeric,
  quantity integer,
  available_quantity integer,
  image_path text
)
language sql
stable
security invoker
set search_path = ''
as $function$
  select
    stock.id,
    stock.sku,
    stock.name,
    stock.price,
    stock.quantity,
    greatest(
      stock.quantity - coalesce(
        sum(items.quantity) filter (where reservation.id is not null),
        0
      )::integer,
      0
    )::integer as available_quantity,
    stock.image_path
  from public.stock_items as stock
  left join public.reservation_items as items
    on items.stock_item_id = stock.id
  left join public.reservations as reservation
    on reservation.id = items.reservation_id
    and reservation.status = 'reserved'
    and reservation.archived_at is null
    and (
      p_exclude_reservation_id is null
      or reservation.id <> p_exclude_reservation_id
    )
  where stock.is_active
    and stock.archived_at is null
  group by
    stock.id,
    stock.sku,
    stock.name,
    stock.price,
    stock.quantity,
    stock.image_path
  order by stock.name, stock.sku;
$function$;

revoke all on function public.get_reservable_stock(uuid) from public, anon;
grant execute on function public.get_reservable_stock(uuid) to authenticated;

create view public.reservation_list
with (security_invoker = true)
as
select
  reservation.id,
  reservation.reservation_no,
  reservation.customer_id,
  customer.name as customer_name,
  customer.email as customer_email,
  customer.phone as customer_phone,
  count(items.id)::bigint as item_count,
  reservation.total,
  reservation.downpayment,
  reservation.balance,
  reservation.status,
  reservation.reserved_at,
  reservation.archived_at,
  reservation.updated_at
from public.reservations as reservation
join public.customers as customer
  on customer.id = reservation.customer_id
left join public.reservation_items as items
  on items.reservation_id = reservation.id
group by
  reservation.id,
  reservation.reservation_no,
  reservation.customer_id,
  customer.name,
  customer.email,
  customer.phone,
  reservation.total,
  reservation.downpayment,
  reservation.balance,
  reservation.status,
  reservation.reserved_at,
  reservation.archived_at,
  reservation.updated_at;

revoke all on table public.reservation_list from anon, authenticated;
grant select on table public.reservation_list to authenticated;

drop function public.get_dashboard_metrics();

create function public.get_dashboard_metrics()
returns table (
  total_customers bigint,
  active_stock_items bigint,
  total_units bigint,
  low_stock_items bigint,
  active_reservations bigint,
  reserved_value numeric,
  outstanding_balance numeric
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
    ) as low_stock_items,
    (
      select count(*)
      from public.reservations
      where archived_at is null and status = 'reserved'
    ) as active_reservations,
    (
      select coalesce(sum(total), 0)
      from public.reservations
      where archived_at is null and status = 'reserved'
    ) as reserved_value,
    (
      select coalesce(sum(balance), 0)
      from public.reservations
      where archived_at is null and status = 'reserved'
    ) as outstanding_balance;
$function$;

revoke all on function public.get_dashboard_metrics() from public;
grant execute on function public.get_dashboard_metrics() to authenticated;

comment on table public.reservations is
  'Reservation headers. Archiving is independent from business status.';
comment on table public.reservation_items is
  'Reservation line items with immutable catalog snapshots for historical accuracy.';
comment on function public.get_reservable_stock(uuid) is
  'Returns physical stock less quantities held by active reserved reservations.';

commit;
