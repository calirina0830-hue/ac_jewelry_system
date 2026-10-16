begin;

-- Partial payment remains active until the reservation still has a balance and
-- at least one item quantity has not been committed to a shipped/pending
-- release. delivered_at alone is not sufficient because it is set on the first
-- release of a partially delivered order.
create or replace function public.get_partially_paid_reservation_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $function$
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
      where item.reservation_id = reservation.id
        and item.quantity > coalesce((
          select sum(shipment_item.quantity)
          from public.reservation_shipment_items as shipment_item
          join public.reservation_shipments as shipment
            on shipment.id = shipment_item.shipment_id
          where shipment_item.reservation_item_id = item.id
            and shipment.status = 'shipped'
        ), 0)
    );
$function$;

revoke all on function public.get_partially_paid_reservation_ids()
  from public, anon;
grant execute on function public.get_partially_paid_reservation_ids()
  to authenticated;

-- Delivered is a complete-delivery view. A manually delivered reservation
-- without shipment rows remains visible for backward compatibility; otherwise
-- every item quantity must be fully committed before it enters Delivered.
create or replace function public.get_fully_delivered_reservation_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $function$
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
    );
$function$;

revoke all on function public.get_fully_delivered_reservation_ids()
  from public, anon;
grant execute on function public.get_fully_delivered_reservation_ids()
  to authenticated;

commit;
