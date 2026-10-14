begin;

-- Keep the reservation's downpayment column and payment ledger in sync from
-- creation so pages that calculate paid totals from ledger rows show the same
-- amount as pages that read the reservation directly.
create or replace function public.create_reservation_with_downpayment(
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
begin
  v_reservation_id := public.create_reservation(
    p_customer_id,
    p_discount,
    p_downpayment,
    p_notes,
    p_items
  );

  if p_downpayment > 0 then
    insert into public.reservation_payments (
      reservation_id,
      amount,
      notes,
      recorded_by
    ) values (
      v_reservation_id,
      p_downpayment,
      'Downpayment entered during reservation creation.',
      v_user_id
    );
  end if;

  return v_reservation_id;
end;
$function$;

revoke all on function public.create_reservation_with_downpayment(
  uuid, numeric, numeric, text, jsonb
) from public, anon;
grant execute on function public.create_reservation_with_downpayment(
  uuid, numeric, numeric, text, jsonb
) to authenticated;

commit;
