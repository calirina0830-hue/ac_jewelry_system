begin;

alter table public.customers
  add column facebook_name text;

alter table public.customers
  add constraint customers_facebook_name_length
  check (facebook_name is null or char_length(btrim(facebook_name)) between 1 and 160);

create index customers_facebook_name_lower_idx
  on public.customers (lower(facebook_name));

grant insert (facebook_name) on table public.customers to authenticated;
grant update (facebook_name) on table public.customers to authenticated;

alter table public.reservation_items
  add column category text;

update public.reservation_items as reservation_item
set category = stock.category
from public.stock_items as stock
where stock.id = reservation_item.stock_item_id;

update public.reservation_items
set category = 'Others'
where category is null;

alter table public.reservation_items
  alter column category set not null,
  add constraint reservation_items_category_valid
  check (category in (
    'Ring', 'Necklace', 'Bracelet', 'Earrings', 'Pendant',
    'Anklet', 'Watch', 'Set', 'Others'
  ));

create index reservation_items_category_idx
  on public.reservation_items (category);

alter table public.reservations
  add column paid_at timestamptz,
  add column delivered_at timestamptz,
  add column cancelled_at timestamptz;

create table public.reservation_status_history (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null
    references public.reservations (id) on delete cascade,
  old_status text,
  new_status text not null,
  changed_by uuid references auth.users (id) on delete set null,
  changed_at timestamptz not null default timezone('utc', now()),
  constraint reservation_status_history_old_status_valid
    check (
      old_status is null
      or old_status in ('reserved', 'paid', 'delivered', 'cancelled')
    ),
  constraint reservation_status_history_new_status_valid
    check (new_status in ('reserved', 'paid', 'delivered', 'cancelled')),
  constraint reservation_status_history_changed
    check (old_status is null or old_status <> new_status)
);

create index reservation_status_history_reservation_idx
  on public.reservation_status_history (reservation_id, changed_at);
create index reservation_status_history_changed_by_idx
  on public.reservation_status_history (changed_by);

revoke all on table public.reservation_status_history from anon, authenticated;
grant select on table public.reservation_status_history to authenticated;

alter table public.reservation_status_history enable row level security;

create policy "reservation_status_history_select_authenticated"
on public.reservation_status_history
for select
to authenticated
using (true);

create policy "reservation_status_history_insert_admin_staff"
on public.reservation_status_history
for insert
to authenticated
with check (
  (select public.current_profile_role()) in ('admin', 'staff')
  and changed_by = (select auth.uid())
);

insert into public.reservation_status_history (
  reservation_id,
  old_status,
  new_status,
  changed_by,
  changed_at
)
select
  reservation.id,
  null,
  reservation.status,
  reservation.created_by,
  reservation.created_at
from public.reservations as reservation
where not exists (
  select 1
  from public.reservation_status_history as history
  where history.reservation_id = reservation.id
);

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
    'AMC Jewelry User'
  );

  if char_length(btrim(resolved_name)) < 2 then
    resolved_name := 'AMC Jewelry User';
  end if;

  insert into public.profiles (id, full_name, role)
  values (new.id, left(resolved_name, 120), 'viewer');

  return new;
end;
$function$;

update public.profiles
set full_name = 'AMC Jewelry User'
where full_name = 'Bella Jewelry User';

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
  v_category text;
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
      and reservation.status in ('reserved', 'paid', 'delivered')
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
      v_category := v_existing.category;
      v_image_path := v_existing.image_path;
    else
      v_item_id := gen_random_uuid();
      v_unit_price := v_stock.price;
      v_item_name := v_stock.name;
      v_sku := v_stock.sku;
      v_category := v_stock.category;
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
        'category', v_category,
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
    category,
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
    prepared.category,
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
    category text,
    quantity integer,
    unit_price numeric,
    discount numeric,
    line_total numeric,
    image_path text
  );

  insert into public.reservation_status_history (
    reservation_id,
    old_status,
    new_status,
    changed_by
  )
  values (v_reservation_id, null, 'reserved', v_user_id);

  return v_reservation_id;
end;
$function$;

revoke all on function public.create_reservation(uuid, numeric, numeric, text, jsonb)
  from public, anon;
grant execute on function public.create_reservation(uuid, numeric, numeric, text, jsonb)
  to authenticated;

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
    category,
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
    prepared.category,
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
    category text,
    quantity integer,
    unit_price numeric,
    discount numeric,
    line_total numeric,
    image_path text
  );

  return p_reservation_id;
end;
$function$;

revoke all on function public.update_reservation(uuid, timestamptz, uuid, numeric, numeric, text, jsonb)
  from public, anon;
grant execute on function public.update_reservation(uuid, timestamptz, uuid, numeric, numeric, text, jsonb)
  to authenticated;

create or replace function public.transition_reservation_status(
  p_reservation_id uuid,
  p_new_status text,
  p_expected_updated_at timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_role public.profile_role;
  v_reservation public.reservations%rowtype;
  v_now timestamptz := timezone('utc', now());
  v_allowed boolean := false;
begin
  if v_user_id is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  v_role := public.current_profile_role();

  if v_role not in ('admin', 'staff') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  if p_new_status not in ('reserved', 'paid', 'delivered', 'cancelled') then
    raise exception 'invalid_status' using errcode = 'P0001';
  end if;

  select reservation.*
  into v_reservation
  from public.reservations as reservation
  where reservation.id = p_reservation_id
  for update;

  if not found then
    raise exception 'reservation_not_found' using errcode = 'P0001';
  end if;

  if v_reservation.archived_at is not null then
    raise exception 'reservation_archived' using errcode = 'P0001';
  end if;

  if v_reservation.updated_at is distinct from p_expected_updated_at then
    raise exception 'stale_reservation' using errcode = 'P0001';
  end if;

  v_allowed :=
    (v_reservation.status = 'reserved' and p_new_status = 'paid')
    or (v_reservation.status = 'paid' and p_new_status = 'delivered')
    or (
      v_role = 'admin'
      and v_reservation.status = 'reserved'
      and p_new_status = 'cancelled'
    );

  if not v_allowed then
    raise exception 'invalid_status_transition:%:%',
      v_reservation.status,
      p_new_status
      using errcode = 'P0001';
  end if;

  update public.reservations
  set
    status = p_new_status,
    downpayment = case
      when p_new_status = 'paid' then total
      else downpayment
    end,
    balance = case
      when p_new_status = 'paid' then 0
      else balance
    end,
    paid_at = case
      when p_new_status = 'paid' then v_now
      else paid_at
    end,
    delivered_at = case
      when p_new_status = 'delivered' then v_now
      else delivered_at
    end,
    cancelled_at = case
      when p_new_status = 'cancelled' then v_now
      else cancelled_at
    end
  where id = p_reservation_id;

  insert into public.reservation_status_history (
    reservation_id,
    old_status,
    new_status,
    changed_by,
    changed_at
  )
  values (
    p_reservation_id,
    v_reservation.status,
    p_new_status,
    v_user_id,
    v_now
  );

  return p_reservation_id;
end;
$function$;

revoke all on function public.transition_reservation_status(uuid, text, timestamptz)
  from public, anon;
grant execute on function public.transition_reservation_status(uuid, text, timestamptz)
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

  if v_reservation.archived_at is not null then
    update public.reservations
    set archived_at = null
    where id = p_reservation_id;
  end if;

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
    and reservation.status in ('reserved', 'paid', 'delivered')
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

create or replace view public.reservation_list
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
  reservation.updated_at,
  customer.facebook_name as customer_facebook_name
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
  reservation.updated_at,
  customer.facebook_name;

revoke all on table public.reservation_list from anon, authenticated;
grant select on table public.reservation_list to authenticated;

create or replace function public.get_reservation_status_history(
  p_reservation_id uuid
)
returns table (
  id uuid,
  old_status text,
  new_status text,
  changed_by uuid,
  changed_by_name text,
  changed_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if auth.uid() is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  return query
  select
    history.id,
    history.old_status,
    history.new_status,
    history.changed_by,
    profile.full_name,
    history.changed_at
  from public.reservation_status_history as history
  left join public.profiles as profile
    on profile.id = history.changed_by
  where history.reservation_id = p_reservation_id
  order by history.changed_at, history.id;
end;
$function$;

revoke all on function public.get_reservation_status_history(uuid)
  from public, anon;
grant execute on function public.get_reservation_status_history(uuid)
  to authenticated;

create or replace function public.get_reservation_category_metrics()
returns table (
  category text,
  reserved_quantity bigint,
  paid_quantity bigint,
  delivered_quantity bigint,
  cancelled_quantity bigint,
  total_quantity bigint,
  committed_value numeric
)
language sql
stable
security invoker
set search_path = ''
as $function$
  with categories(category, position) as (
    values
      ('Ring'::text, 1),
      ('Necklace'::text, 2),
      ('Bracelet'::text, 3),
      ('Earrings'::text, 4),
      ('Pendant'::text, 5),
      ('Anklet'::text, 6),
      ('Watch'::text, 7),
      ('Set'::text, 8),
      ('Others'::text, 9)
  )
  select
    categories.category,
    coalesce(sum(items.quantity) filter (
      where reservation.status = 'reserved' and reservation.archived_at is null
    ), 0)::bigint as reserved_quantity,
    coalesce(sum(items.quantity) filter (
      where reservation.status = 'paid' and reservation.archived_at is null
    ), 0)::bigint as paid_quantity,
    coalesce(sum(items.quantity) filter (
      where reservation.status = 'delivered' and reservation.archived_at is null
    ), 0)::bigint as delivered_quantity,
    coalesce(sum(items.quantity) filter (
      where reservation.status = 'cancelled' and reservation.archived_at is null
    ), 0)::bigint as cancelled_quantity,
    coalesce(sum(items.quantity) filter (
      where reservation.archived_at is null
    ), 0)::bigint as total_quantity,
    coalesce(sum(items.line_total) filter (
      where reservation.status in ('reserved', 'paid', 'delivered')
        and reservation.archived_at is null
    ), 0)::numeric as committed_value
  from categories
  left join public.reservation_items as items
    on items.category = categories.category
  left join public.reservations as reservation
    on reservation.id = items.reservation_id
  group by categories.category, categories.position
  order by categories.position;
$function$;

revoke all on function public.get_reservation_category_metrics()
  from public, anon;
grant execute on function public.get_reservation_category_metrics()
  to authenticated;

drop function public.get_dashboard_metrics();

create function public.get_dashboard_metrics()
returns table (
  total_customers bigint,
  active_stock_items bigint,
  total_units bigint,
  low_stock_items bigint,
  active_reservations bigint,
  reserved_count bigint,
  paid_count bigint,
  delivered_count bigint,
  cancelled_count bigint,
  reserved_value numeric,
  paid_value numeric,
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
      where archived_at is null and status in ('reserved', 'paid')
    ) as active_reservations,
    (
      select count(*)
      from public.reservations
      where archived_at is null and status = 'reserved'
    ) as reserved_count,
    (
      select count(*)
      from public.reservations
      where archived_at is null and status = 'paid'
    ) as paid_count,
    (
      select count(*)
      from public.reservations
      where archived_at is null and status = 'delivered'
    ) as delivered_count,
    (
      select count(*)
      from public.reservations
      where archived_at is null and status = 'cancelled'
    ) as cancelled_count,
    (
      select coalesce(sum(total), 0)
      from public.reservations
      where archived_at is null and status = 'reserved'
    ) as reserved_value,
    (
      select coalesce(sum(total), 0)
      from public.reservations
      where archived_at is null and status in ('paid', 'delivered')
    ) as paid_value,
    (
      select coalesce(sum(balance), 0)
      from public.reservations
      where archived_at is null and status = 'reserved'
    ) as outstanding_balance;
$function$;

revoke all on function public.get_dashboard_metrics() from public;
grant execute on function public.get_dashboard_metrics() to authenticated;

comment on column public.customers.facebook_name is
  'Customer-facing Facebook or client-service display name.';
comment on column public.reservation_items.category is
  'Category snapshot retained independently from later stock catalog changes.';
comment on table public.reservation_status_history is
  'Append-only audit timeline for atomic reservation status transitions.';

commit;
