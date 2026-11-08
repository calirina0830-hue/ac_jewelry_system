begin;

-- Edit order > Downpayment sets the amount paid on a reservation directly.
-- The existing payment row is overwritten rather than adding a correction
-- row. A new row is written only when the reservation has no active payment.
-- With several active payments the newest are adjusted first, so older
-- entries stay as recorded whenever the new amount still covers them.
create or replace function public.set_reservation_paid_amount(
  p_reservation_id uuid,
  p_expected_updated_at timestamptz,
  p_amount numeric
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_reservation public.reservations%rowtype;
  v_payment public.reservation_payments%rowtype;
  v_others numeric(12, 2);
  v_needed numeric(12, 2);
  v_placed boolean := false;
  v_balance numeric(12, 2);
  v_new_status text;
  v_now timestamptz := timezone('utc', now());
begin
  if v_user_id is null
     or coalesce(public.current_profile_role()::text, '') not in ('admin', 'staff') then
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
  if v_reservation.archived_at is not null
     or v_reservation.status not in ('reserved', 'paid') then
    raise exception 'reservation_not_editable' using errcode = 'P0001';
  end if;
  if v_reservation.updated_at is distinct from p_expected_updated_at then
    raise exception 'stale_reservation' using errcode = 'P0001';
  end if;
  if p_amount is null
     or p_amount = 'NaN'::numeric
     or p_amount < 0
     or p_amount <> round(p_amount, 2) then
    raise exception 'invalid_payment' using errcode = 'P0001';
  end if;
  if p_amount > v_reservation.total then
    raise exception 'payment_exceeds_balance' using errcode = 'P0001';
  end if;

  perform 1
  from public.reservation_payments as payment
  where payment.reservation_id = p_reservation_id
    and payment.voided_at is null
  for update;

  select coalesce(sum(payment.amount), 0)::numeric(12, 2)
  into v_others
  from public.reservation_payments as payment
  where payment.reservation_id = p_reservation_id
    and payment.voided_at is null;

  for v_payment in
    select payment.*
    from public.reservation_payments as payment
    where payment.reservation_id = p_reservation_id
      and payment.voided_at is null
    order by payment.recorded_at desc, payment.id desc
  loop
    v_others := v_others - v_payment.amount;
    v_needed := p_amount - v_others;

    if v_needed > 0 then
      update public.reservation_payments
      set amount = v_needed
      where id = v_payment.id;
      v_placed := true;
      exit;
    end if;

    -- The older payments already reach the new amount; retire this one.
    update public.reservation_payments
    set
      voided_at = v_now,
      voided_by = v_user_id,
      void_reason = 'Removed when the downpayment was edited.'
    where id = v_payment.id;
  end loop;

  if not v_placed and p_amount > 0 then
    insert into public.reservation_payments (
      reservation_id, amount, notes, recorded_by, recorded_at
    )
    values (
      p_reservation_id, p_amount, 'Entered as downpayment in Edit order.',
      v_user_id, v_now
    );
  end if;

  v_balance := v_reservation.total - p_amount;
  v_new_status := case when v_balance = 0 then 'paid' else 'reserved' end;

  update public.reservations
  set
    balance = v_balance,
    status = v_new_status,
    paid_at = case
      when v_new_status = 'paid' then coalesce(v_reservation.paid_at, v_now)
      else null
    end,
    updated_at = v_now
  where id = p_reservation_id;

  if v_reservation.status::text <> v_new_status then
    insert into public.reservation_status_history (
      reservation_id, old_status, new_status, changed_by, changed_at, reason
    )
    values (
      p_reservation_id, v_reservation.status, v_new_status, v_user_id, v_now,
      case
        when v_new_status = 'paid' then 'Downpayment edited; the balance is settled.'
        else 'Downpayment edited; a balance remains due.'
      end
    );
  end if;

  return jsonb_build_object(
    'reservationId', p_reservation_id,
    'totalPaid', p_amount,
    'balance', v_balance,
    'status', v_new_status
  );
end;
$function$;

revoke all on function public.set_reservation_paid_amount(uuid, timestamptz, numeric)
  from public, anon;
grant execute on function public.set_reservation_paid_amount(uuid, timestamptz, numeric)
  to authenticated;

commit;
