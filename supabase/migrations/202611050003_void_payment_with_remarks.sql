begin;

-- Replace the old delete-style payment RPC with an audited void operation.
-- The ledger row is still retained; only its active contribution is removed.
drop function if exists public.delete_reservation_payment(
  uuid, timestamptz, timestamptz
);

create or replace function public.delete_reservation_payment(
  p_payment_id uuid,
  p_expected_payment_recorded_at timestamptz,
  p_expected_reservation_updated_at timestamptz,
  p_void_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_reservation_id uuid;
  v_reservation public.reservations%rowtype;
  v_payment public.reservation_payments%rowtype;
  v_items_subtotal numeric(12, 2);
  v_items_total numeric(12, 2);
  v_total_paid numeric(12, 2);
  v_balance numeric(12, 2);
  v_new_status text;
  v_now timestamptz := timezone('utc', now());
begin
  if v_user_id is null
     or coalesce(public.current_profile_role()::text, '') not in ('admin', 'staff') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  if p_void_reason is null
     or char_length(btrim(p_void_reason)) < 3
     or char_length(btrim(p_void_reason)) > 1000 then
    raise exception 'invalid_void_reason' using errcode = 'P0001';
  end if;

  select payment.reservation_id
  into v_reservation_id
  from public.reservation_payments as payment
  where payment.id = p_payment_id;

  if not found then
    raise exception 'payment_not_found' using errcode = 'P0001';
  end if;

  select reservation.*
  into v_reservation
  from public.reservations as reservation
  where reservation.id = v_reservation_id
  for update;

  if not found then
    raise exception 'reservation_not_found' using errcode = 'P0001';
  end if;
  if v_reservation.archived_at is not null
     or v_reservation.status not in ('reserved', 'paid') then
    raise exception 'reservation_not_editable' using errcode = 'P0001';
  end if;
  if v_reservation.updated_at is distinct from p_expected_reservation_updated_at then
    raise exception 'stale_reservation' using errcode = 'P0001';
  end if;

  select payment.*
  into v_payment
  from public.reservation_payments as payment
  where payment.id = p_payment_id
    and payment.reservation_id = v_reservation_id
  for update;

  if not found or v_payment.voided_at is not null then
    raise exception 'payment_not_editable' using errcode = 'P0001';
  end if;
  if v_payment.recorded_at is distinct from p_expected_payment_recorded_at then
    raise exception 'stale_payment' using errcode = 'P0001';
  end if;

  select coalesce(sum(payment.amount), 0)::numeric(12, 2)
  into v_total_paid
  from public.reservation_payments as payment
  where payment.reservation_id = v_reservation_id
    and payment.voided_at is null
    and payment.id <> p_payment_id;

  if v_total_paid < 0 then
    raise exception 'deduction_exceeds_paid' using errcode = 'P0001';
  end if;

  -- Voiding a deduction increases the amount paid. Never let that operation
  -- push active payments above the lower of the stored total and item value.
  if v_payment.amount < 0 then
    select coalesce(
      sum((item.unit_price * item.quantity) - item.discount),
      0
    )::numeric(12, 2)
    into v_items_subtotal
    from public.reservation_items as item
    where item.reservation_id = v_reservation_id;

    v_items_total := greatest(v_items_subtotal - v_reservation.discount, 0);
    if v_total_paid > least(v_reservation.total, v_items_total) then
      raise exception 'payment_delete_exceeds_total' using errcode = 'P0001';
    end if;
  end if;

  v_balance := greatest(v_reservation.total - v_total_paid, 0);
  v_new_status := case when v_balance = 0 then 'paid' else 'reserved' end;

  update public.reservation_payments
  set
    voided_at = v_now,
    voided_by = v_user_id,
    void_reason = btrim(p_void_reason)
  where id = p_payment_id;

  update public.reservations
  set
    balance = v_balance,
    status = v_new_status,
    paid_at = case
      when v_new_status = 'paid' then coalesce(v_reservation.paid_at, v_now)
      else null
    end,
    updated_at = v_now
  where id = v_reservation_id;

  if v_reservation.status <> v_new_status then
    insert into public.reservation_status_history (
      reservation_id,
      old_status,
      new_status,
      changed_by,
      changed_at,
      reason
    ) values (
      v_reservation_id,
      v_reservation.status,
      v_new_status,
      v_user_id,
      v_now,
      case
        when v_new_status = 'paid' then 'Payment voided; reservation remains settled.'
        else 'Payment voided; remaining balance recalculated.'
      end
    );
  end if;

  return jsonb_build_object(
    'reservationId', v_reservation_id,
    'paymentId', p_payment_id,
    'totalPaid', v_total_paid,
    'balance', v_balance,
    'status', v_new_status
  );
end;
$function$;

revoke all on function public.delete_reservation_payment(
  uuid, timestamptz, timestamptz, text
) from public, anon;
grant execute on function public.delete_reservation_payment(
  uuid, timestamptz, timestamptz, text
) to authenticated;

commit;
