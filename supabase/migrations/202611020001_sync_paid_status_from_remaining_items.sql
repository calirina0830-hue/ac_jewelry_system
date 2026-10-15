begin;

-- Keep the stored reservation status aligned with the balance of items that
-- are still awaiting release. Payments already applied to pending/shipped
-- releases do not pay those remaining items a second time.
create or replace function public.sync_reservation_remaining_payment_status(
  p_reservation_id uuid,
  p_changed_by uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_reservation public.reservations%rowtype;
  v_original_gross numeric := 0;
  v_remaining_gross numeric := 0;
  v_remaining_subtotal numeric := 0;
  v_remaining_discount numeric := 0;
  v_remaining_total numeric(12, 2) := 0;
  v_remaining_quantity integer := 0;
  v_total_paid numeric(12, 2) := 0;
  v_applied_to_releases numeric(12, 2) := 0;
  v_paid_toward_remaining numeric(12, 2) := 0;
  v_remaining_balance numeric(12, 2) := 0;
  v_new_status text;
  v_now timestamptz := timezone('utc', now());
begin
  select reservation.*
  into v_reservation
  from public.reservations as reservation
  where reservation.id = p_reservation_id
  for update;

  if not found
     or v_reservation.archived_at is not null
     or v_reservation.status not in ('reserved', 'paid') then
    return;
  end if;

  with released_by_item as (
    select
      shipment_item.reservation_item_id,
      sum(shipment_item.quantity)::integer as released_quantity
    from public.reservation_shipment_items as shipment_item
    join public.reservation_shipments as shipment
      on shipment.id = shipment_item.shipment_id
    where shipment.reservation_id = p_reservation_id
      and shipment.status in ('pending', 'shipped')
    group by shipment_item.reservation_item_id
  ),
  item_values as (
    select
      item.quantity as original_quantity,
      least(
        greatest(coalesce(released.released_quantity, 0), 0),
        item.quantity
      )::integer as released_quantity,
      item.unit_price,
      item.discount
    from public.reservation_items as item
    left join released_by_item as released
      on released.reservation_item_id = item.id
    where item.reservation_id = p_reservation_id
  ),
  calculated as (
    select
      coalesce(sum(item.unit_price * item.original_quantity), 0) as original_gross,
      coalesce(sum(
        item.unit_price * (item.original_quantity - item.released_quantity)
      ), 0) as remaining_gross,
      coalesce(sum(greatest(
        ((item.unit_price * item.original_quantity) - item.discount)
          - greatest(
              (item.unit_price * item.released_quantity)
                - case
                    when item.original_quantity > 0 then round(
                      item.discount * item.released_quantity
                        / item.original_quantity,
                      2
                    )
                    else 0
                  end,
              0
            ),
        0
      )), 0) as remaining_subtotal,
      coalesce(sum(
        item.original_quantity - item.released_quantity
      ), 0)::integer as remaining_quantity
    from item_values as item
  )
  select
    calculated.original_gross,
    calculated.remaining_gross,
    calculated.remaining_subtotal,
    calculated.remaining_quantity
  into
    v_original_gross,
    v_remaining_gross,
    v_remaining_subtotal,
    v_remaining_quantity
  from calculated;

  v_remaining_discount := case
    when v_original_gross > 0 then round(
      v_reservation.discount * v_remaining_gross / v_original_gross,
      2
    )
    else 0
  end;
  v_remaining_total := greatest(
    round(v_remaining_subtotal - v_remaining_discount, 2),
    0
  );

  select coalesce(sum(payment.amount), 0)::numeric(12, 2)
  into v_total_paid
  from public.reservation_payments as payment
  where payment.reservation_id = p_reservation_id
    and payment.voided_at is null;

  select coalesce(sum(shipment.downpayment_applied), 0)::numeric(12, 2)
  into v_applied_to_releases
  from public.reservation_shipments as shipment
  where shipment.reservation_id = p_reservation_id
    and shipment.status in ('pending', 'shipped');

  v_paid_toward_remaining := greatest(
    v_total_paid - v_applied_to_releases,
    0
  );
  v_remaining_balance := greatest(
    v_remaining_total - v_paid_toward_remaining,
    0
  );
  v_new_status := case
    when v_remaining_quantity <= 0 then v_reservation.status
    when v_remaining_balance = 0 then 'paid'
    else 'reserved'
  end;

  update public.reservations
  set
    balance = v_remaining_balance,
    status = v_new_status,
    paid_at = case
      when v_new_status = 'paid' then coalesce(v_reservation.paid_at, v_now)
      else null
    end,
    updated_at = v_now
  where id = p_reservation_id
    and (
      balance is distinct from v_remaining_balance
      or status is distinct from v_new_status
      or (v_new_status = 'paid' and paid_at is null)
      or (v_new_status = 'reserved' and paid_at is not null)
    );

  if v_reservation.status is distinct from v_new_status then
    insert into public.reservation_status_history (
      reservation_id,
      old_status,
      new_status,
      changed_by,
      changed_at,
      reason
    ) values (
      p_reservation_id,
      v_reservation.status,
      v_new_status,
      p_changed_by,
      v_now,
      case
        when v_new_status = 'paid' then
          'Remaining reservation items are fully paid.'
        else
          'Remaining reservation items have an outstanding balance.'
      end
    );
  end if;
end;
$function$;

revoke all on function public.sync_reservation_remaining_payment_status(uuid, uuid)
  from public, anon, authenticated;

create or replace function public.trigger_sync_reservation_remaining_payment_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_reservation_id uuid;
begin
  if tg_table_name = 'reservation_payments' then
    v_reservation_id := coalesce(new.reservation_id, old.reservation_id);
  elsif tg_table_name = 'reservation_items' then
    v_reservation_id := coalesce(new.reservation_id, old.reservation_id);
  elsif tg_table_name = 'reservation_shipments' then
    v_reservation_id := coalesce(new.reservation_id, old.reservation_id);
  elsif tg_table_name = 'reservation_shipment_items' then
    select shipment.reservation_id
    into v_reservation_id
    from public.reservation_shipments as shipment
    where shipment.id = coalesce(new.shipment_id, old.shipment_id);
  end if;

  if v_reservation_id is not null then
    perform public.sync_reservation_remaining_payment_status(
      v_reservation_id,
      auth.uid()
    );
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$function$;

revoke all on function public.trigger_sync_reservation_remaining_payment_status()
  from public, anon, authenticated;

drop trigger if exists reservation_payments_sync_remaining_status
  on public.reservation_payments;
create constraint trigger reservation_payments_sync_remaining_status
after insert or update or delete on public.reservation_payments
deferrable initially deferred
for each row execute function public.trigger_sync_reservation_remaining_payment_status();

drop trigger if exists reservation_items_sync_remaining_status
  on public.reservation_items;
create constraint trigger reservation_items_sync_remaining_status
after insert or update or delete on public.reservation_items
deferrable initially deferred
for each row execute function public.trigger_sync_reservation_remaining_payment_status();

drop trigger if exists reservation_shipments_sync_remaining_status
  on public.reservation_shipments;
create constraint trigger reservation_shipments_sync_remaining_status
after insert or update or delete on public.reservation_shipments
deferrable initially deferred
for each row execute function public.trigger_sync_reservation_remaining_payment_status();

drop trigger if exists reservation_shipment_items_sync_remaining_status
  on public.reservation_shipment_items;
create constraint trigger reservation_shipment_items_sync_remaining_status
after insert or update or delete on public.reservation_shipment_items
deferrable initially deferred
for each row execute function public.trigger_sync_reservation_remaining_payment_status();

-- Move existing qualifying reservations into Paid immediately.
do $reconcile$
declare
  v_reservation_id uuid;
begin
  for v_reservation_id in
    select reservation.id
    from public.reservations as reservation
    where reservation.archived_at is null
      and reservation.status in ('reserved', 'paid')
  loop
    perform public.sync_reservation_remaining_payment_status(
      v_reservation_id,
      null
    );
  end loop;
end;
$reconcile$;

commit;
