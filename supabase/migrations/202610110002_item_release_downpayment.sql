begin;

-- Partial Item Release: extend every release (reservation_shipments) with the
-- portion of the reservation's downpayment (total paid) being used for the
-- released items, and record the per-item allocation so the remaining
-- unapplied downpayment and each released item's outstanding balance follow
-- exactly from the release history. Releases are created only through the
-- prepare/confirm/cancel RPCs, so invariant enforcement lives in the RPC and
-- the shipping quantity rules are unchanged.

-- This file may already have been applied, so column and constraint changes
-- are guarded and every function is "create or replace" — it is safe to
-- re-run the whole file after a partial or completed apply.

do $migration$
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'reservation_shipments'
      and column_name = 'downpayment_applied'
  ) then
    alter table public.reservation_shipments
      add column downpayment_applied numeric(12, 2) not null default 0;
  end if;
end;
$migration$;

alter table public.reservation_shipments
  alter column downpayment_applied set default 0;

alter table public.reservation_shipments
  alter column downpayment_applied set not null;

do $migration$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'reservation_shipments_downpayment_applied_nonnegative'
      and conrelid = 'public.reservation_shipments'::regclass
  ) then
    alter table public.reservation_shipments
      add constraint reservation_shipments_downpayment_applied_nonnegative
        check (downpayment_applied >= 0);
  end if;
end;
$migration$;

do $migration$
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'reservation_shipment_items'
      and column_name = 'downpayment_allocated'
  ) then
    alter table public.reservation_shipment_items
      add column downpayment_allocated numeric(12, 2) not null default 0;
  end if;
end;
$migration$;

alter table public.reservation_shipment_items
  alter column downpayment_allocated set default 0;

alter table public.reservation_shipment_items
  alter column downpayment_allocated set not null;

do $migration$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'reservation_shipment_items_downpayment_allocated_nonnegative'
      and conrelid = 'public.reservation_shipment_items'::regclass
  ) then
    alter table public.reservation_shipment_items
      add constraint reservation_shipment_items_downpayment_allocated_nonnegative
        check (downpayment_allocated >= 0);
  end if;
end;
$migration$;

-- Downpayment already reserved by pending and shipped releases for a
-- reservation. Used to prevent applying the same downpayment twice.
create or replace function public.reservation_downpayment_committed(
  p_reservation_id uuid
)
returns numeric(12, 2)
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(
    sum(shipment.downpayment_applied),
    0
  )::numeric(12, 2)
  from public.reservation_shipments as shipment
  where shipment.reservation_id = p_reservation_id
    and shipment.status in ('pending', 'shipped');
$function$;

revoke all on function public.reservation_downpayment_committed(uuid)
  from public, anon;
grant execute on function public.reservation_downpayment_committed(uuid)
  to authenticated;

create or replace function public.prepare_reservation_shipment(
  p_reservation_id uuid,
  p_items jsonb,
  p_downpayment_applied numeric default 0
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
  v_released_values numeric(12, 2)[] := array[]::numeric(12, 2)[];
  v_released_value numeric(12, 2) := 0;
  v_max_applicable numeric(12, 2) := 0;
  v_committed_downpayment numeric(12, 2) := 0;
  v_allocated numeric(12, 2);
  v_remainder numeric(12, 2) := p_downpayment_applied;
  v_position integer := 0;
  v_count integer;
begin
  if v_user_id is null
     or public.current_profile_role() not in ('admin', 'staff') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  if jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) < 1
     or jsonb_array_length(p_items) > 200 then
    raise exception 'invalid_release_items' using errcode = 'P0001';
  end if;

  if p_downpayment_applied is null
     or p_downpayment_applied <> round(p_downpayment_applied, 2)
     or p_downpayment_applied < 0
     or p_downpayment_applied > 9999999999.99 then
    raise exception 'invalid_downpayment_application' using errcode = 'P0001';
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
    raise exception 'reservation_not_releasable' using errcode = 'P0001';
  end if;

  perform items.id
  from public.reservation_items as items
  where items.reservation_id = p_reservation_id
  order by items.id
  for update;

  v_count := jsonb_array_length(p_items);

  for v_input in
    select item.value
    from jsonb_array_elements(p_items) with ordinality as item(value, position)
    order by item.position
  loop
    if jsonb_typeof(v_input) <> 'object' then
      raise exception 'invalid_release_items' using errcode = 'P0001';
    end if;

    begin
      v_item_id := nullif(v_input ->> 'reservation_item_id', '')::uuid;
      v_quantity := (v_input ->> 'quantity')::integer;
    exception
      when invalid_text_representation or numeric_value_out_of_range then
        raise exception 'invalid_release_items' using errcode = 'P0001';
    end;

    if v_item_id is null or v_quantity is null or v_quantity < 1 then
      raise exception 'invalid_release_items' using errcode = 'P0001';
    end if;

    if v_item_id = any(v_seen_ids) then
      raise exception 'duplicate_release_item' using errcode = 'P0001';
    end if;
    v_seen_ids := array_append(v_seen_ids, v_item_id);

    select items.*
    into v_item
    from public.reservation_items as items
    where items.id = v_item_id
      and items.reservation_id = p_reservation_id;

    if not found then
      raise exception 'release_item_not_found:%', v_item_id
        using errcode = 'P0001';
    end if;

    v_committed := public.reservation_item_committed_quantity(v_item_id);
    v_available := greatest(v_item.quantity - v_committed, 0);

    if v_quantity > v_available then
      raise exception 'insufficient_release_quantity:%:%:%',
        v_item_id, v_available, v_item.quantity
        using errcode = 'P0001';
    end if;

    -- Net value of the released units (pro-rates the line discount).
    v_released_value := round(
      v_item.unit_price * v_quantity
      - coalesce(v_item.discount, 0) * v_quantity / v_item.quantity,
      2
    );
    v_released_values := array_append(v_released_values, v_released_value);
    v_max_applicable := v_max_applicable + v_released_value;
  end loop;

  if p_downpayment_applied > v_max_applicable then
    raise exception 'downpayment_exceeds_released_value:%', v_max_applicable
      using errcode = 'P0001';
  end if;

  v_committed_downpayment :=
    public.reservation_downpayment_committed(p_reservation_id);

  if v_committed_downpayment + p_downpayment_applied > v_reservation.downpayment then
    raise exception 'insufficient_downpayment:%:%:%',
      v_reservation.downpayment,
      v_committed_downpayment,
      p_downpayment_applied
      using errcode = 'P0001';
  end if;

  insert into public.reservation_shipments (
    reservation_id, status, downpayment_applied, created_by
  )
  values (p_reservation_id, 'pending', p_downpayment_applied, v_user_id)
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

  -- Apply the downpayment across the selected items in selection order, each
  -- capped at that item's released value, so every item keeps a zero or
  -- positive outstanding balance and the sum of allocations always equals the
  -- amount applied.
  if p_downpayment_applied > 0 then
    for v_input, v_position in
      select item.value, item.position
      from jsonb_array_elements(p_items) with ordinality as item(value, position)
      order by item.position
    loop
      v_released_value := v_released_values[v_position];
      if v_remainder > 0 then
        v_allocated := least(v_remainder, v_released_value);
        v_remainder := v_remainder - v_allocated;

        update public.reservation_shipment_items
        set downpayment_allocated = v_allocated
        where shipment_id = v_shipment_id
          and reservation_item_id = nullif(v_input ->> 'reservation_item_id', '')::uuid;
      end if;
    end loop;
  end if;

  return jsonb_build_object(
    'shipmentId', v_shipment_id,
    'shipmentNo', v_shipment_no,
    'status', 'pending',
    'itemCount', jsonb_array_length(p_items),
    'totalQuantity', v_total_quantity,
    'downpaymentApplied', p_downpayment_applied
  );
exception
  when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'invalid_release_items' using errcode = 'P0001';
end;
$function$;

revoke all on function public.prepare_reservation_shipment(uuid, jsonb, numeric)
  from public, anon;
grant execute on function public.prepare_reservation_shipment(uuid, jsonb, numeric)
  to authenticated;

-- Preserve the two-argument call for callers that release without applying
-- any downpayment.
create or replace function public.prepare_reservation_shipment(
  p_reservation_id uuid,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
begin
  return public.prepare_reservation_shipment(p_reservation_id, p_items, 0);
end;
$function$;

revoke all on function public.prepare_reservation_shipment(uuid, jsonb)
  from public, anon;
grant execute on function public.prepare_reservation_shipment(uuid, jsonb)
  to authenticated;

commit;