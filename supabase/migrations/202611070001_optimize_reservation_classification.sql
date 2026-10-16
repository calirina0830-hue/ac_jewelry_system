-- Optimize the derived Reserved / Partially Paid / Delivered lookups.
-- These indexes support the shipped-quantity aggregation and active-payment
-- checks used by the classification functions.
create index if not exists reservations_status_balance_idx
  on public.reservations (status, balance, id)
  where archived_at is null;

create index if not exists reservation_shipments_shipped_reservation_idx
  on public.reservation_shipments (reservation_id, id)
  where status = 'shipped';

create index if not exists reservation_shipment_items_item_quantity_idx
  on public.reservation_shipment_items (reservation_item_id, shipment_id, quantity);

create or replace function public.get_partially_paid_reservation_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $function$
  with shipped_quantity as (
    select shipment_item.reservation_item_id,
           sum(shipment_item.quantity)::numeric as quantity
    from public.reservation_shipment_items as shipment_item
    join public.reservation_shipments as shipment
      on shipment.id = shipment_item.shipment_id
     and shipment.status = 'shipped'
    group by shipment_item.reservation_item_id
  )
  select reservation.id
  from public.reservations as reservation
  where reservation.status = 'reserved'
    and reservation.balance > 0
    and exists (
      select 1
      from public.reservation_payments as payment
      where payment.reservation_id = reservation.id
        and payment.voided_at is null
        and payment.amount > 0
    )
    and exists (
      select 1
      from public.reservation_items as item
      left join shipped_quantity
        on shipped_quantity.reservation_item_id = item.id
      where item.reservation_id = reservation.id
        and item.quantity > coalesce(shipped_quantity.quantity, 0)
    );
$function$;

create or replace function public.get_fully_delivered_reservation_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $function$
  with shipped_quantity as (
    select shipment_item.reservation_item_id,
           sum(shipment_item.quantity)::numeric as quantity
    from public.reservation_shipment_items as shipment_item
    join public.reservation_shipments as shipment
      on shipment.id = shipment_item.shipment_id
     and shipment.status = 'shipped'
    group by shipment_item.reservation_item_id
  )
  select reservation.id
  from public.reservations as reservation
  where reservation.delivered_at is not null
    and (
      not exists (
        select 1
        from public.reservation_shipments as shipment
        where shipment.reservation_id = reservation.id
      )
      or not exists (
        select 1
        from public.reservation_items as item
        left join shipped_quantity
          on shipped_quantity.reservation_item_id = item.id
        where item.reservation_id = reservation.id
          and item.quantity > coalesce(shipped_quantity.quantity, 0)
      )
    );
$function$;

revoke all on function public.get_partially_paid_reservation_ids() from public, anon;
grant execute on function public.get_partially_paid_reservation_ids() to authenticated;
revoke all on function public.get_fully_delivered_reservation_ids() from public, anon;
grant execute on function public.get_fully_delivered_reservation_ids() to authenticated;
