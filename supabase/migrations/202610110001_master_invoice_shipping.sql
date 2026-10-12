begin;

-- Master invoice + selective shipping.
--
-- 1. Every reservation line item stores the exact date/time it was mined or
--    added via `ordered_at`. Existing historical rows keep NULL so the app can
--    honestly show "order date unavailable" instead of inventing a date.
-- 2. New items always stamp `ordered_at` at insert time (import, manual create,
--    or "add to existing master invoice"), so later edits cannot rewrite history.
-- 3. Shipments are first-class records. A reservation can have many partial
--    shipments; shipping one batch never marks the whole reservation shipped.

alter table public.reservation_items
  add column ordered_at timestamptz;

comment on column public.reservation_items.ordered_at is
  'Date/time the item was mined or added to the master invoice. NULL for legacy rows with no captured date.';

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

create trigger reservation_items_set_ordered_at
before insert on public.reservation_items
for each row execute function public.set_reservation_item_ordered_at();

create sequence public.reservation_shipment_number_seq
  as bigint start with 1 increment by 1;

create or replace function public.next_shipment_number()
returns text
language sql
volatile
security definer
set search_path = ''
as $function$
  select
    'SHP-' ||
    to_char(timezone('Asia/Manila', now()), 'YYYY') ||
    '-' ||
    lpad(nextval('public.reservation_shipment_number_seq')::text, 6, '0');
$function$;

revoke all on sequence public.reservation_shipment_number_seq
  from public, anon, authenticated;
revoke all on function public.next_shipment_number()
  from public, anon, authenticated;

create table public.reservation_shipments (
  id uuid primary key default gen_random_uuid(),
  shipment_no text not null unique default public.next_shipment_number(),
  reservation_id uuid not null
    references public.reservations (id) on delete cascade,
  status text not null default 'pending',
  notes text,
  cancel_reason text,
  shipped_at timestamptz,
  cancelled_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint reservation_shipments_number_format
    check (shipment_no ~ '^SHP-[0-9]{4}-[0-9]{6,}$'),
  constraint reservation_shipments_status_valid
    check (status in ('pending', 'shipped', 'cancelled')),
  constraint reservation_shipments_shipped_at_present
    check (status <> 'shipped' or shipped_at is not null),
  constraint reservation_shipments_notes_length
    check (notes is null or char_length(notes) <= 2000),
  constraint reservation_shipments_cancel_reason_length
    check (cancel_reason is null or char_length(cancel_reason) <= 1000)
);

create table public.reservation_shipment_items (
  id uuid primary key default gen_random_uuid(),
  shipment_id uuid not null
    references public.reservation_shipments (id) on delete cascade,
  reservation_item_id uuid not null
    references public.reservation_items (id) on delete restrict,
  quantity integer not null,
  ordered_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint reservation_shipment_items_quantity_positive
    check (quantity > 0),
  constraint reservation_shipment_items_unique_item
    unique (shipment_id, reservation_item_id)
);

create index reservation_shipments_reservation_idx
  on public.reservation_shipments (reservation_id, created_at);
create index reservation_shipments_status_idx
  on public.reservation_shipments (status);
create index reservation_shipment_items_shipment_idx
  on public.reservation_shipment_items (shipment_id);
create index reservation_shipment_items_item_idx
  on public.reservation_shipment_items (reservation_item_id);

create trigger reservation_shipments_set_updated_at
before update on public.reservation_shipments
for each row execute function public.set_updated_at();

create trigger reservation_shipment_items_set_updated_at
before update on public.reservation_shipment_items
for each row execute function public.set_updated_at();

revoke all on table public.reservation_shipments from anon, authenticated;
revoke all on table public.reservation_shipment_items from anon, authenticated;
grant select on table public.reservation_shipments to authenticated;
grant select on table public.reservation_shipment_items to authenticated;

alter table public.reservation_shipments enable row level security;
alter table public.reservation_shipment_items enable row level security;

create policy "reservation_shipments_select_authenticated"
on public.reservation_shipments
for select
to authenticated
using (true);

create policy "reservation_shipment_items_select_authenticated"
on public.reservation_shipment_items
for select
to authenticated
using (true);

-- Committed quantity for an item across open and completed shipments.
create or replace function public.reservation_item_committed_quantity(
  p_reservation_item_id uuid
)
returns integer
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(sum(items.quantity), 0)::integer
  from public.reservation_shipment_items as items
  join public.reservation_shipments as shipment
    on shipment.id = items.shipment_id
  where items.reservation_item_id = p_reservation_item_id
    and shipment.status in ('pending', 'shipped');
$function$;

revoke all on function public.reservation_item_committed_quantity(uuid)
  from public, anon;
grant execute on function public.reservation_item_committed_quantity(uuid)
  to authenticated;

create or replace function public.prepare_reservation_shipment(
  p_reservation_id uuid,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_reservation public.reservations%rowtype;
  v_input jsonb;
  v_item public.reservation_items%rowtype;
  v_item_id uuid;
  v_quantity integer;
  v_committed integer;
  v_available integer;
  v_seen_ids uuid[] := array[]::uuid[];
  v_shipment_id uuid;
  v_shipment_no text;
  v_total_quantity integer := 0;
begin
  if v_user_id is null
     or public.current_profile_role() not in ('admin', 'staff') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  if jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) < 1
     or jsonb_array_length(p_items) > 200 then
    raise exception 'invalid_shipment_items' using errcode = 'P0001';
  end if;

  select reservation.*
  into v_reservation
  from public.reservations as reservation
  where reservation.id = p_reservation_id
  for update;

  if not found then
    raise exception 'reservation_not_found' using errcode = 'P0001';
  end if;
  if v_reservation.archived_at is not null
     or v_reservation.status not in ('reserved', 'paid', 'delivered') then
    raise exception 'reservation_not_shippable' using errcode = 'P0001';
  end if;

  perform items.id
  from public.reservation_items as items
  where items.reservation_id = p_reservation_id
  order by items.id
  for update;

  for v_input in
    select item.value
    from jsonb_array_elements(p_items) with ordinality as item(value, position)
    order by item.position
  loop
    if jsonb_typeof(v_input) <> 'object' then
      raise exception 'invalid_shipment_items' using errcode = 'P0001';
    end if;

    begin
      v_item_id := nullif(v_input ->> 'reservation_item_id', '')::uuid;
      v_quantity := (v_input ->> 'quantity')::integer;
    exception
      when invalid_text_representation or numeric_value_out_of_range then
        raise exception 'invalid_shipment_items' using errcode = 'P0001';
    end;

    if v_item_id is null or v_quantity is null or v_quantity < 1 then
      raise exception 'invalid_shipment_items' using errcode = 'P0001';
    end if;

    if v_item_id = any(v_seen_ids) then
      raise exception 'duplicate_shipment_item' using errcode = 'P0001';
    end if;
    v_seen_ids := array_append(v_seen_ids, v_item_id);

    select items.*
    into v_item
    from public.reservation_items as items
    where items.id = v_item_id
      and items.reservation_id = p_reservation_id;

    if not found then
      raise exception 'shipment_item_not_found:%', v_item_id
        using errcode = 'P0001';
    end if;

    v_committed := public.reservation_item_committed_quantity(v_item_id);
    v_available := greatest(v_item.quantity - v_committed, 0);

    if v_quantity > v_available then
      raise exception 'insufficient_shipment_quantity:%:%:%',
        v_item_id, v_available, v_item.quantity
        using errcode = 'P0001';
    end if;
  end loop;

  insert into public.reservation_shipments (
    reservation_id, status, created_by
  )
  values (p_reservation_id, 'pending', v_user_id)
  returning id, shipment_no into v_shipment_id, v_shipment_no;

  insert into public.reservation_shipment_items (
    shipment_id, reservation_item_id, quantity, ordered_at
  )
  select
    v_shipment_id,
    items.id,
    (input.value ->> 'quantity')::integer,
    items.ordered_at
  from jsonb_array_elements(p_items) as input(value)
  join public.reservation_items as items
    on items.id = (input.value ->> 'reservation_item_id')::uuid;

  select coalesce(sum(items.quantity), 0)::integer
  into v_total_quantity
  from public.reservation_shipment_items as items
  where items.shipment_id = v_shipment_id;

  return jsonb_build_object(
    'shipmentId', v_shipment_id,
    'shipmentNo', v_shipment_no,
    'status', 'pending',
    'itemCount', jsonb_array_length(p_items),
    'totalQuantity', v_total_quantity
  );
exception
  when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'invalid_shipment_items' using errcode = 'P0001';
end;
$function$;

revoke all on function public.prepare_reservation_shipment(uuid, jsonb)
  from public, anon;
grant execute on function public.prepare_reservation_shipment(uuid, jsonb)
  to authenticated;

create or replace function public.confirm_reservation_shipment(
  p_shipment_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_shipment public.reservation_shipments%rowtype;
  v_now timestamptz := timezone('utc', now());
begin
  if v_user_id is null
     or public.current_profile_role() not in ('admin', 'staff') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  select shipment.*
  into v_shipment
  from public.reservation_shipments as shipment
  where shipment.id = p_shipment_id
  for update;

  if not found then
    raise exception 'shipment_not_found' using errcode = 'P0001';
  end if;
  if v_shipment.status <> 'pending' then
    raise exception 'invalid_shipment_transition' using errcode = 'P0001';
  end if;

  update public.reservation_shipments
  set
    status = 'shipped',
    shipped_at = v_now
  where id = p_shipment_id;

  return jsonb_build_object(
    'shipmentId', v_shipment.id,
    'shipmentNo', v_shipment.shipment_no,
    'status', 'shipped',
    'shippedAt', v_now
  );
end;
$function$;

revoke all on function public.confirm_reservation_shipment(uuid)
  from public, anon;
grant execute on function public.confirm_reservation_shipment(uuid)
  to authenticated;

create or replace function public.cancel_reservation_shipment(
  p_shipment_id uuid,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_role public.profile_role;
  v_shipment public.reservation_shipments%rowtype;
  v_now timestamptz := timezone('utc', now());
  v_reason text := nullif(btrim(p_reason), '');
begin
  if v_user_id is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  v_role := public.current_profile_role();

  if v_role not in ('admin', 'staff') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_reason is not null and char_length(v_reason) > 1000 then
    raise exception 'invalid_cancel_reason' using errcode = 'P0001';
  end if;

  select shipment.*
  into v_shipment
  from public.reservation_shipments as shipment
  where shipment.id = p_shipment_id
  for update;

  if not found then
    raise exception 'shipment_not_found' using errcode = 'P0001';
  end if;
  if v_shipment.status = 'cancelled' then
    return jsonb_build_object(
      'shipmentId', v_shipment.id,
      'shipmentNo', v_shipment.shipment_no,
      'status', 'cancelled'
    );
  end if;
  if v_shipment.status = 'shipped' and v_role <> 'admin' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  update public.reservation_shipments
  set
    status = 'cancelled',
    cancelled_at = v_now,
    cancel_reason = v_reason
  where id = p_shipment_id;

  return jsonb_build_object(
    'shipmentId', v_shipment.id,
    'shipmentNo', v_shipment.shipment_no,
    'status', 'cancelled',
    'cancelledAt', v_now
  );
end;
$function$;

revoke all on function public.cancel_reservation_shipment(uuid, text)
  from public, anon;
grant execute on function public.cancel_reservation_shipment(uuid, text)
  to authenticated;

create or replace function public.set_reservation_item_ordered_at(
  p_reservation_item_id uuid,
  p_ordered_at timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_item public.reservation_items%rowtype;
  v_reservation public.reservations%rowtype;
begin
  if auth.uid() is null or public.current_profile_role() <> 'admin' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_ordered_at is null or p_ordered_at > timezone('utc', now()) then
    raise exception 'invalid_ordered_at' using errcode = 'P0001';
  end if;

  select items.*
  into v_item
  from public.reservation_items as items
  where items.id = p_reservation_item_id
  for update;

  if not found then
    raise exception 'reservation_item_not_found' using errcode = 'P0001';
  end if;

  select reservation.*
  into v_reservation
  from public.reservations as reservation
  where reservation.id = v_item.reservation_id
  for update;

  if v_reservation.archived_at is not null
     or v_reservation.status = 'cancelled' then
    raise exception 'reservation_not_editable' using errcode = 'P0001';
  end if;

  update public.reservation_items
  set ordered_at = p_ordered_at
  where id = p_reservation_item_id;

  update public.reservation_shipment_items
  set ordered_at = p_ordered_at
  where reservation_item_id = p_reservation_item_id
    and ordered_at is null;

  return p_reservation_item_id;
end;
$function$;

revoke all on function public.set_reservation_item_ordered_at(uuid, timestamptz)
  from public, anon;
grant execute on function public.set_reservation_item_ordered_at(uuid, timestamptz)
  to authenticated;

-- Rewrite update_reservation so editing a reservation updates existing lines in
-- place. This preserves each item's ordered_at/created_at instead of deleting
-- and re-inserting every line (which would destroy the captured mining date).
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

  -- Refuse to drop lines that already belong to a shipment record.
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
          image_path text
        )
        where prepared.id = items.id
      )
  ) then
    raise exception 'reservation_item_has_shipments' using errcode = 'P0001';
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
        image_path text
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
    image_path = prepared.image_path
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
  )
  where not exists (
    select 1
    from public.reservation_items as existing
    where existing.id = prepared.id
      and existing.reservation_id = p_reservation_id
  );

  -- An edited line can never shrink below what has already been shipped or is
  -- pending shipment.
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

comment on table public.reservation_shipments is
  'Individual shipments for a reservation. A reservation may have many partial shipments.';
comment on table public.reservation_shipment_items is
  'Line items included in a shipment, with a snapshot of the original order date.';

commit;
