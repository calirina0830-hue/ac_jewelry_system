begin;

-- Returns reservations that have an active payment but still have an amount
-- remaining. The security-definer lookup keeps the page from requiring direct
-- client-role access to the payment ledger table.
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
    and reservation.delivered_at is null
    and exists (
      select 1
      from public.reservation_payments as payment
      where payment.reservation_id = reservation.id
        and payment.voided_at is null
        and payment.amount > 0
    );
$function$;

revoke all on function public.get_partially_paid_reservation_ids()
  from public, anon;
grant execute on function public.get_partially_paid_reservation_ids()
  to authenticated;

-- The reservation list displays payment totals and the export reads the same
-- ledger, so authenticated application users need read access to payment rows.
grant select on table public.reservation_payments to authenticated;

commit;
