-- Function to record and confirm an item release atomically with custom date and notes
create or replace function public.release_reservation_items(
  p_reservation_id uuid,
  p_items jsonb,
  p_release_date timestamptz default timezone('utc', now()),
  p_downpayment_applied numeric default 0,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_prepared jsonb;
  v_shipment_id uuid;
  v_shipment_no text;
  v_notes text := nullif(btrim(p_notes), '');
  v_release_date timestamptz := coalesce(p_release_date, timezone('utc', now()));
begin
  if v_user_id is null
     or public.current_profile_role() not in ('admin', 'staff') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  if v_notes is not null and char_length(v_notes) > 2000 then
    raise exception 'notes_too_long' using errcode = 'P0001';
  end if;

  -- Call prepare_reservation_shipment to validate items, stock holds, and downpayment
  v_prepared := public.prepare_reservation_shipment(
    p_reservation_id,
    p_items,
    p_downpayment_applied
  );

  v_shipment_id := (v_prepared ->> 'shipmentId')::uuid;
  v_shipment_no := v_prepared ->> 'shipmentNo';

  -- Directly confirm and update status, shipped_at, notes
  update public.reservation_shipments
  set
    status = 'shipped',
    shipped_at = v_release_date,
    notes = v_notes,
    updated_at = timezone('utc', now())
  where id = v_shipment_id;

  return jsonb_build_object(
    'shipmentId', v_shipment_id,
    'shipmentNo', v_shipment_no,
    'status', 'shipped',
    'shippedAt', v_release_date,
    'itemCount', (v_prepared ->> 'itemCount')::integer,
    'totalQuantity', (v_prepared ->> 'totalQuantity')::integer,
    'downpaymentApplied', (v_prepared ->> 'downpaymentApplied')::numeric
  );
end;
$function$;

revoke all on function public.release_reservation_items(uuid, jsonb, timestamptz, numeric, text)
  from public, anon;
grant execute on function public.release_reservation_items(uuid, jsonb, timestamptz, numeric, text)
  to authenticated;
