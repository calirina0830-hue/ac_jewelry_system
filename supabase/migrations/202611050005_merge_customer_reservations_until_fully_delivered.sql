begin;

-- A reservation can already have delivered_at set after a partial release,
-- while still having unreleased items. Continue the same customer's order in
-- that reservation until every item quantity is fully committed to a release.
do $migration$
declare
  v_function_oid oid;
  v_definition text;
  v_updated_definition text;
begin
  v_function_oid := to_regprocedure(
    'public.create_reservation_with_downpayment(uuid,numeric,numeric,text,jsonb)'
  );

  if v_function_oid is null then
    raise exception 'required_create_reservation_with_downpayment_function_not_found';
  end if;

  v_definition := pg_get_functiondef(v_function_oid);
  if position('reservation.delivered_at is null' in lower(v_definition)) = 0 then
    return;
  end if;

  v_updated_definition := replace(
    v_definition,
    '    and reservation.delivered_at is null',
    $replacement$    and exists (
      select 1
      from public.reservation_items as existing_item
      where existing_item.reservation_id = reservation.id
        and existing_item.quantity > coalesce((
          select sum(shipment_item.quantity)
          from public.reservation_shipment_items as shipment_item
          join public.reservation_shipments as shipment
            on shipment.id = shipment_item.shipment_id
          where shipment_item.reservation_item_id = existing_item.id
            and shipment.status = 'shipped'
        ), 0)
    )$replacement$
  );
  v_updated_definition := replace(
    v_updated_definition,
    'order by reservation.reserved_at, reservation.created_at, reservation.id',
    'order by (reservation.delivered_at is not null) desc, reservation.reserved_at, reservation.created_at, reservation.id'
  );

  if v_updated_definition = v_definition then
    raise exception 'unable_to_patch_reservation_merge_unreleased_item_guard';
  end if;

  execute v_updated_definition;
end;
$migration$;

-- Consolidate duplicate Reserved rows already created for the same customer
-- when at least one of the rows still has unreleased items. Fully delivered
-- rows are intentionally left separate.
do $migration$
declare
  v_group record;
  v_target_id uuid;
  v_duplicate record;
begin
  for v_group in
    select reservation.customer_id
    from public.reservations as reservation
    where reservation.archived_at is null
      and reservation.status = 'reserved'
      and exists (
        select 1
        from public.reservation_items as item
        where item.reservation_id = reservation.id
          and item.quantity > coalesce((
            select sum(shipment_item.quantity)
            from public.reservation_shipment_items as shipment_item
            join public.reservation_shipments as shipment
              on shipment.id = shipment_item.shipment_id
            where shipment_item.reservation_item_id = item.id
              and shipment.status = 'shipped'
          ), 0)
      )
    group by reservation.customer_id
    having count(*) > 1
  loop
    select reservation.id
    into v_target_id
    from public.reservations as reservation
    where reservation.customer_id = v_group.customer_id
      and reservation.archived_at is null
      and reservation.status = 'reserved'
      and exists (
        select 1
        from public.reservation_items as item
        where item.reservation_id = reservation.id
          and item.quantity > coalesce((
            select sum(shipment_item.quantity)
            from public.reservation_shipment_items as shipment_item
            join public.reservation_shipments as shipment
              on shipment.id = shipment_item.shipment_id
            where shipment_item.reservation_item_id = item.id
              and shipment.status = 'shipped'
          ), 0)
      )
    -- Prefer the partially delivered reservation so its delivery timestamp
    -- and existing shipment history remain attached to the primary order.
    order by (reservation.delivered_at is not null) desc,
             reservation.reserved_at,
             reservation.created_at,
             reservation.id
    limit 1
    for update;

    for v_duplicate in
      select reservation.*
      from public.reservations as reservation
      where reservation.customer_id = v_group.customer_id
        and reservation.archived_at is null
        and reservation.status = 'reserved'
        and reservation.id <> v_target_id
        and exists (
          select 1
          from public.reservation_items as item
          where item.reservation_id = reservation.id
            and item.quantity > public.reservation_item_committed_quantity(item.id)
        )
      order by reservation.reserved_at, reservation.created_at, reservation.id
      for update
    loop
      update public.reservation_items
      set reservation_id = v_target_id
      where reservation_id = v_duplicate.id;

      update public.reservation_payments
      set reservation_id = v_target_id
      where reservation_id = v_duplicate.id;

      update public.reservation_status_history
      set reservation_id = v_target_id
      where reservation_id = v_duplicate.id;

      update public.reservation_shipments
      set reservation_id = v_target_id
      where reservation_id = v_duplicate.id;

      update public.reservations as target
      set
        subtotal = target.subtotal + v_duplicate.subtotal,
        discount = target.discount + v_duplicate.discount,
        downpayment = target.downpayment + v_duplicate.downpayment,
        total = target.total + v_duplicate.total,
        balance = target.balance + v_duplicate.balance,
        pricing_complete = target.pricing_complete and v_duplicate.pricing_complete,
        notes = case
          when nullif(btrim(target.notes), '') is null then v_duplicate.notes
          when nullif(btrim(v_duplicate.notes), '') is null
            or target.notes = v_duplicate.notes then target.notes
          else left(target.notes || E'\n' || v_duplicate.notes, 4000)
        end
      where target.id = v_target_id;

      delete from public.reservations
      where id = v_duplicate.id;
    end loop;
  end loop;
end;
$migration$;

commit;
