begin;

-- Payment corrections preserve the immutable payment history: void the old
-- active entry and insert its replacement in the same transaction.
create or replace function public.edit_reservation_payment(
  p_payment_id uuid,
  p_expected_payment_recorded_at timestamptz,
  p_expected_reservation_updated_at timestamptz,
  p_amount numeric,
  p_payment_method text,
  p_reference_no text,
  p_notes text
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
  v_other_paid numeric(12, 2);
  v_total_paid numeric(12, 2);
  v_balance numeric(12, 2);
  v_new_status text;
  v_replacement_id uuid;
  v_now timestamptz := timezone('utc', now());
begin
  if v_user_id is null
     or coalesce(public.current_profile_role()::text, '') not in ('admin', 'staff') then
    raise exception 'not_authorized' using errcode = '42501';
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
  if not v_reservation.pricing_complete
     or exists (
       select 1
       from public.reservation_items as item
       where item.reservation_id = v_reservation_id
         and not item.price_confirmed
     ) then
    raise exception 'pricing_incomplete' using errcode = 'P0001';
  end if;
  if v_reservation.total <= 0 then
    raise exception 'invalid_reservation_total' using errcode = 'P0001';
  end if;
  if p_amount is null
     or p_amount = 'NaN'::numeric
     or p_amount = 0
     or abs(p_amount) > 9999999999.99
     or p_amount <> round(p_amount, 2)
     or char_length(coalesce(p_payment_method, '')) > 120
     or char_length(coalesce(p_reference_no, '')) > 200
     or char_length(coalesce(p_notes, '')) > 2000 then
    raise exception 'invalid_payment' using errcode = 'P0001';
  end if;

  select coalesce(sum(payment.amount), 0)::numeric(12, 2)
  into v_other_paid
  from public.reservation_payments as payment
  where payment.reservation_id = v_reservation_id
    and payment.voided_at is null
    and payment.id <> p_payment_id;

  v_total_paid := v_other_paid + p_amount;
  if v_total_paid < 0 then
    raise exception 'deduction_exceeds_paid' using errcode = 'P0001';
  end if;
  if v_total_paid > v_reservation.total then
    raise exception 'payment_exceeds_balance' using errcode = 'P0001';
  end if;

  v_balance := greatest(v_reservation.total - v_total_paid, 0);
  v_new_status := case when v_balance = 0 then 'paid' else 'reserved' end;

  insert into public.reservation_payments (
    reservation_id,
    amount,
    payment_method,
    reference_no,
    evidence_path,
    notes,
    recorded_by,
    recorded_at
  ) values (
    v_reservation_id,
    p_amount,
    nullif(btrim(p_payment_method), ''),
    nullif(btrim(p_reference_no), ''),
    null,
    nullif(btrim(p_notes), ''),
    v_user_id,
    v_now
  ) returning id into v_replacement_id;

  update public.reservation_payments
  set
    voided_at = v_now,
    voided_by = v_user_id,
    void_reason = 'Edited and replaced by payment ' || v_replacement_id::text || '.'
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

  if v_reservation.status::text <> v_new_status then
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
        when v_new_status = 'paid' then 'Payment record corrected; reservation balance is settled.'
        else 'Payment record corrected; reservation balance remains due.'
      end
    );
  end if;

  return jsonb_build_object(
    'reservationId', v_reservation_id,
    'paymentId', v_replacement_id,
    'replacedPaymentId', p_payment_id,
    'totalPaid', v_total_paid,
    'balance', v_balance,
    'status', v_new_status
  );
end;
$function$;

revoke all on function public.edit_reservation_payment(
  uuid, timestamptz, timestamptz, numeric, text, text, text
) from public, anon;
grant execute on function public.edit_reservation_payment(
  uuid, timestamptz, timestamptz, numeric, text, text, text
) to authenticated;

commit;
