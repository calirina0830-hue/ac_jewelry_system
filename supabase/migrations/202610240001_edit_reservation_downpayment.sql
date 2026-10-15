begin;

-- Keep reservation edits and the append-only payment ledger atomic. The
-- existing update_reservation function remains the single source of validation
-- for items and totals; this wrapper records only the downpayment difference.
create or replace function public.update_reservation_with_payment_adjustment(
  p_reservation_id uuid,
  p_expected_updated_at timestamptz,
  p_customer_id uuid,
  p_discount numeric,
  p_downpayment numeric,
  p_notes text,
  p_items jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_reservation_id uuid;
  v_ledger_total numeric(12, 2);
  v_adjustment numeric(12, 2);
  v_committed numeric(12, 2);
begin
  v_committed := public.reservation_downpayment_committed(p_reservation_id);
  if p_downpayment < v_committed then
    raise exception 'downpayment_below_committed:%', v_committed
      using errcode = 'P0001';
  end if;

  v_reservation_id := public.update_reservation(
    p_reservation_id,
    p_expected_updated_at,
    p_customer_id,
    p_discount,
    p_downpayment,
    p_notes,
    p_items
  );

  select coalesce(sum(payment.amount), 0)::numeric(12, 2)
  into v_ledger_total
  from public.reservation_payments as payment
  where payment.reservation_id = v_reservation_id
    and payment.voided_at is null;

  v_adjustment := p_downpayment - v_ledger_total;
  if v_adjustment <> 0 then
    insert into public.reservation_payments (
      reservation_id,
      amount,
      payment_method,
      notes,
      recorded_by
    ) values (
      v_reservation_id,
      v_adjustment,
      'Reservation edit',
      case
        when v_adjustment > 0 then 'Downpayment increased while editing reservation.'
        else 'Downpayment reduced while editing reservation.'
      end,
      v_user_id
    );
  end if;

  return v_reservation_id;
end;
$function$;

revoke all on function public.update_reservation_with_payment_adjustment(
  uuid, timestamptz, uuid, numeric, numeric, text, jsonb
) from public, anon;
grant execute on function public.update_reservation_with_payment_adjustment(
  uuid, timestamptz, uuid, numeric, numeric, text, jsonb
) to authenticated;

commit;
