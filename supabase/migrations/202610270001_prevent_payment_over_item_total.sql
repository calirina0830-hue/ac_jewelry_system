begin;

-- Guard every new ledger entry against the current snapshot value of its
-- reservation items, even if the stored reservations.total has drifted.
-- Defer until commit so a payment correction can void the old row and insert
-- its replacement atomically without temporarily counting both entries.
create or replace function public.enforce_reservation_payment_item_total()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_payment public.reservation_payments%rowtype;
  v_reservation public.reservations%rowtype;
  v_items_subtotal numeric(12, 2);
  v_items_total numeric(12, 2);
  v_active_paid numeric(12, 2);
begin
  select payment.*
  into v_payment
  from public.reservation_payments as payment
  where payment.id = new.id;

  -- A corrected payment may have been voided later in the same transaction.
  if not found or v_payment.voided_at is not null then
    return new;
  end if;

  select reservation.*
  into v_reservation
  from public.reservations as reservation
  where reservation.id = v_payment.reservation_id;

  if not found then
    raise exception 'reservation_not_found' using errcode = 'P0001';
  end if;

  select coalesce(
    sum((item.unit_price * item.quantity) - item.discount),
    0
  )::numeric(12, 2)
  into v_items_subtotal
  from public.reservation_items as item
  where item.reservation_id = v_payment.reservation_id;

  v_items_total := greatest(v_items_subtotal - v_reservation.discount, 0);

  select coalesce(sum(payment.amount), 0)::numeric(12, 2)
  into v_active_paid
  from public.reservation_payments as payment
  where payment.reservation_id = v_payment.reservation_id
    and payment.voided_at is null;

  if v_active_paid < 0 then
    raise exception 'deduction_exceeds_paid' using errcode = 'P0001';
  end if;
  if v_active_paid > v_items_total then
    raise exception 'payment_exceeds_items_total:%:%', v_active_paid, v_items_total
      using errcode = 'P0001';
  end if;

  return new;
end;
$function$;

revoke all on function public.enforce_reservation_payment_item_total()
  from public, anon, authenticated;

drop trigger if exists reservation_payments_item_total_guard
  on public.reservation_payments;

create constraint trigger reservation_payments_item_total_guard
after insert on public.reservation_payments
deferrable initially deferred
for each row
execute function public.enforce_reservation_payment_item_total();

commit;
