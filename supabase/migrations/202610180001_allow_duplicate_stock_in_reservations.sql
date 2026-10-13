-- Complete Migration: Fix duplicate items, order dates, and committed quantity helper
-- 
-- 1. Ensure reservation_items.ordered_at column and trigger exist
-- 2. Create helper reservation_item_committed_quantity
-- 3. Create prepare_reservation_items (allows duplicate stock lines + retains order dates)
-- 4. Create update_reservation (updates lines in place, preserving order dates)

-- Step 1: Ensure column ordered_at exists on reservation_items
alter table public.reservation_items
  add column if not exists ordered_at timestamptz;

create or replace function public.set_reservation_item_ordered_at()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.ordered_at is null then
    new.ordered_at := timezone('utc', now());
  end if;

  return new;
end;
$function$;

drop trigger if exists reservation_items_set_ordered_at on public.reservation_items;
create trigger reservation_items_set_ordered_at
before insert on public.reservation_items
for each row execute function public.set_reservation_item_ordered_at();

-- Step 2: Committed quantity helper (checks shipments table if exists)
create or replace function public.reservation_item_committed_quantity(
  p_reservation_item_id uuid
)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  v_committed integer := 0;
begin
  if exists (
    select 1
    from information_schema.tables
    where table_schema = 'public'
      and table_name = 'reservation_shipment_items'
  ) then
    select coalesce(sum(items.quantity), 0)::integer
    into v_committed
    from public.reservation_shipment_items as items
    join public.reservation_shipments as shipment
      on shipment.id = items.shipment_id
    where items.reservation_item_id = p_reservation_item_id
      and shipment.status in ('pending', 'shipped');
  end if;

  return coalesce(v_committed, 0);
end;
$function$;

revoke all on function public.reservation_item_committed_quantity(uuid)
  from public, anon;
grant execute on function public.reservation_item_committed_quantity(uuid)
  to authenticated;

-- Step 3: prepare_reservation_items
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
      v_unit_price := (v_input ->> 'selling_price')::numeric;
    exception
      when invalid_text_representation or numeric_value_out_of_range then
        raise exception 'invalid_reservation_items' using errcode = 'P0001';
    end;

    if v_stock_id is null
       or v_quantity is null
       or v_quantity < 1
       or v_discount is null
       or v_discount = 'NaN'::numeric
       or v_discount < 0
       or v_discount > 9999999999.99
       or v_discount <> round(v_discount, 2)
       or v_unit_price is null
       or v_unit_price = 'NaN'::numeric
       or v_unit_price < 0
       or v_unit_price > 9999999999.99
       or v_unit_price <> round(v_unit_price, 2) then
      raise exception 'invalid_reservation_items' using errcode = 'P0001';
    end if;

    select stock.*
    into v_stock
    from public.stock_items as stock
    where stock.id = v_stock_id;

    if not found
       or not v_stock.is_active
       or v_stock.archived_at is not null then
      raise exception 'stock_item_unavailable:%', v_stock_id using errcode = 'P0001';
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

      v_item_name := v_existing.item_name;
      v_sku := v_existing.sku;
      v_category := v_existing.category;
      v_image_path := v_existing.image_path;
    else
      v_item_id := gen_random_uuid();
      v_existing.ordered_at := null;
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
        'image_path', v_image_path,
        'ordered_at', coalesce(v_existing.ordered_at, nullif(v_input ->> 'ordered_at', '')::timestamptz, timezone('utc', now()))
      )
    );
  end loop;

  if v_subtotal > 9999999999.99 then
    raise exception 'reservation_total_too_large' using errcode = 'P0001';
  end if;

  return jsonb_build_object('items', v_prepared_items, 'subtotal', v_subtotal);
end;
$function$;

revoke all on function public.prepare_reservation_items(jsonb, uuid)
  from public, anon, authenticated;

-- Step 4: update_reservation
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
  v_has_shipment_items boolean := false;
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

  select exists (
    select 1
    from information_schema.tables
    where table_schema = 'public'
      and table_name = 'reservation_shipment_items'
  ) into v_has_shipment_items;

  if v_has_shipment_items then
    if exists (
      select 1
      from public.reservation_shipment_items as shipment_item
      join public.reservation_items as items
        on items.id = shipment_item.reservation_item_id
      where items.reservation_id = p_reservation_id
        and not exists (
          select 1
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
            image_path text,
            ordered_at timestamptz
          )
          where prepared.id = items.id
        )
    ) then
      raise exception 'reservation_item_has_shipments' using errcode = 'P0001';
    end if;
  end if;

  delete from public.reservation_items as items
  where items.reservation_id = p_reservation_id
    and not exists (
      select 1
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
        image_path text,
        ordered_at timestamptz
      )
      where prepared.id = items.id
    );

  update public.reservation_items as items
  set
    stock_item_id = prepared.stock_item_id,
    item_name = prepared.item_name,
    sku = prepared.sku,
    category = prepared.category,
    quantity = prepared.quantity,
    unit_price = prepared.unit_price,
    discount = prepared.discount,
    line_total = prepared.line_total,
    image_path = prepared.image_path,
    ordered_at = coalesce(items.ordered_at, prepared.ordered_at)
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
    image_path text,
    ordered_at timestamptz
  )
  where items.id = prepared.id
    and items.reservation_id = p_reservation_id;

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
    image_path,
    ordered_at
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
    prepared.image_path,
    prepared.ordered_at
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
    image_path text,
    ordered_at timestamptz
  )
  where not exists (
    select 1
    from public.reservation_items as existing
    where existing.id = prepared.id
      and existing.reservation_id = p_reservation_id
  );

  if exists (
    select 1
    from public.reservation_items as items
    where items.reservation_id = p_reservation_id
      and items.quantity < public.reservation_item_committed_quantity(items.id)
  ) then
    raise exception 'reservation_item_below_committed' using errcode = 'P0001';
  end if;

  return p_reservation_id;
end;
$function$;

revoke all on function public.update_reservation(uuid, timestamptz, uuid, numeric, numeric, text, jsonb)
  from public, anon;
grant execute on function public.update_reservation(uuid, timestamptz, uuid, numeric, numeric, text, jsonb)
  to authenticated;
