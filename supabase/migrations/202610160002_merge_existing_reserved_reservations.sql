begin;

-- Merge pre-existing active reservations for the same customer. Future live
-- imports already reuse an active reserved reservation; this backfill brings
-- older duplicate records into the same master reservation model.
do $migration$
declare
  v_customer_id uuid;
  v_reservation_id uuid;
  v_reservation_batch_id uuid;
  v_duplicate record;
  v_source_item record;
  v_target_item_id uuid;
  v_source_shipment_item record;
  v_target_shipment_item_id uuid;
  v_target_shipment_quantity integer;
  v_combined_quantity integer;
  v_combined_line_total numeric(12, 2);
  v_combined_gross numeric;
  v_combined_unit_price numeric(12, 2);
  v_combined_discount numeric(12, 2);
  v_combined_subtotal numeric(12, 2);
  v_combined_reservation_discount numeric(12, 2);
  v_combined_downpayment numeric(12, 2);
  v_combined_total numeric(12, 2);
  v_combined_balance numeric(12, 2);
  v_combined_pricing_complete boolean;
  v_combined_notes text;
  v_batch_ids uuid[] := array[]::uuid[];
begin
  for v_customer_id in
    select reservation.customer_id
    from public.reservations as reservation
    where reservation.status = 'reserved'
      and reservation.archived_at is null
    group by reservation.customer_id
    having count(*) > 1
  loop
    select reservation.id
    into v_reservation_id
    from public.reservations as reservation
    where reservation.customer_id = v_customer_id
      and reservation.status = 'reserved'
      and reservation.archived_at is null
    order by reservation.reserved_at, reservation.created_at, reservation.id
    limit 1
    for update;

    select reservation.import_batch_id
    into v_reservation_batch_id
    from public.reservations as reservation
    where reservation.id = v_reservation_id;
    if v_reservation_batch_id is not null then
      v_batch_ids := array_append(v_batch_ids, v_reservation_batch_id);
    end if;

    for v_duplicate in
      select
        reservation.id,
        reservation.subtotal,
        reservation.discount,
        reservation.downpayment,
        reservation.total,
        reservation.balance,
        reservation.pricing_complete,
        reservation.notes,
        reservation.import_batch_id
      from public.reservations as reservation
      where reservation.customer_id = v_customer_id
        and reservation.status = 'reserved'
        and reservation.archived_at is null
        and reservation.id <> v_reservation_id
      order by reservation.reserved_at, reservation.created_at, reservation.id
      for update
    loop
      select
        reservation.subtotal + v_duplicate.subtotal,
        reservation.discount + v_duplicate.discount,
        reservation.downpayment + v_duplicate.downpayment,
        reservation.total + v_duplicate.total,
        reservation.balance + v_duplicate.balance,
        reservation.pricing_complete and v_duplicate.pricing_complete,
        case
          when nullif(btrim(reservation.notes), '') is null then v_duplicate.notes
          when nullif(btrim(v_duplicate.notes), '') is null
            or reservation.notes = v_duplicate.notes then reservation.notes
          else left(reservation.notes || E'\n' || v_duplicate.notes, 4000)
        end
      into
        v_combined_subtotal,
        v_combined_reservation_discount,
        v_combined_downpayment,
        v_combined_total,
        v_combined_balance,
        v_combined_pricing_complete,
        v_combined_notes
      from public.reservations as reservation
      where reservation.id = v_reservation_id;

      if v_duplicate.import_batch_id is not null then
        v_batch_ids := array_append(v_batch_ids, v_duplicate.import_batch_id);
      end if;

      for v_source_item in
        select item.*
        from public.reservation_items as item
        where item.reservation_id = v_duplicate.id
        order by item.created_at, item.id
      loop
        v_target_item_id := null;
        select item.id
        into v_target_item_id
        from public.reservation_items as item
        where item.reservation_id = v_reservation_id
          and item.stock_item_id = v_source_item.stock_item_id
        limit 1
        for update;

        if v_target_item_id is null then
          update public.reservation_items
          set reservation_id = v_reservation_id
          where id = v_source_item.id;
        else
          select
            item.quantity + v_source_item.quantity,
            item.line_total + v_source_item.line_total,
            item.unit_price * item.quantity
              + v_source_item.unit_price * v_source_item.quantity
          into
            v_combined_quantity,
            v_combined_line_total,
            v_combined_gross
          from public.reservation_items as item
          where item.id = v_target_item_id;

          v_combined_unit_price :=
            ceil(v_combined_gross / v_combined_quantity * 100) / 100;
          v_combined_discount :=
            v_combined_unit_price * v_combined_quantity - v_combined_line_total;

          for v_source_shipment_item in
            select shipment_item.id, shipment_item.shipment_id, shipment_item.quantity
            from public.reservation_shipment_items as shipment_item
            where shipment_item.reservation_item_id = v_source_item.id
            for update
          loop
            v_target_shipment_item_id := null;
            select shipment_item.id, shipment_item.quantity
            into v_target_shipment_item_id, v_target_shipment_quantity
            from public.reservation_shipment_items as shipment_item
            where shipment_item.shipment_id = v_source_shipment_item.shipment_id
              and shipment_item.reservation_item_id = v_target_item_id
            limit 1
            for update;

            if v_target_shipment_item_id is null then
              update public.reservation_shipment_items
              set reservation_item_id = v_target_item_id
              where id = v_source_shipment_item.id;
            else
              update public.reservation_shipment_items
              set quantity = v_target_shipment_quantity + v_source_shipment_item.quantity
              where id = v_target_shipment_item_id;
              delete from public.reservation_shipment_items
              where id = v_source_shipment_item.id;
            end if;
          end loop;

          update public.reservation_items
          set
            quantity = v_combined_quantity,
            unit_price = v_combined_unit_price,
            discount = v_combined_discount,
            line_total = v_combined_line_total,
            price_confirmed = price_confirmed and v_source_item.price_confirmed,
            ordered_at = case
              when ordered_at is null then v_source_item.ordered_at
              when v_source_item.ordered_at is null then ordered_at
              else least(ordered_at, v_source_item.ordered_at)
            end
          where id = v_target_item_id;

          delete from public.reservation_items
          where id = v_source_item.id;
        end if;
      end loop;

      update public.reservation_payments
      set reservation_id = v_reservation_id
      where reservation_id = v_duplicate.id;

      update public.reservation_status_history
      set reservation_id = v_reservation_id
      where reservation_id = v_duplicate.id;

      update public.reservation_shipments
      set reservation_id = v_reservation_id
      where reservation_id = v_duplicate.id;

      update public.reservations
      set
        subtotal = v_combined_subtotal,
        discount = v_combined_reservation_discount,
        downpayment = v_combined_downpayment,
        total = v_combined_total,
        balance = v_combined_balance,
        pricing_complete = v_combined_pricing_complete,
        notes = v_combined_notes
      where id = v_reservation_id;

      delete from public.reservations
      where id = v_duplicate.id;

      v_target_item_id := null;
      v_target_shipment_item_id := null;
    end loop;
  end loop;

  update public.reservation_import_batches as batch
  set total_value = coalesce((
    select sum(reservation.total)
    from public.reservations as reservation
    where reservation.import_batch_id = batch.id
  ), 0)
  where batch.id = any(v_batch_ids);
end;
$migration$;

commit;
