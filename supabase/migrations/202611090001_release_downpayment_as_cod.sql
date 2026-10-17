begin;

-- Release downpayment is the amount paid for this handover. It may be less
-- than the released goods value; the difference remains cash on delivery.
-- Ordinary shipment preparation keeps its existing reservation-downpayment
-- guard. Only the item-release RPC opts into the release-specific rule.
do $migration$
declare
  v_function_oid oid;
  v_definition text;
  v_updated_definition text;
begin
  v_function_oid := to_regprocedure(
    'public.prepare_reservation_shipment(uuid,jsonb,numeric)'
  );

  if v_function_oid is null then
    raise exception 'required_prepare_reservation_shipment_function_not_found';
  end if;

  v_definition := pg_get_functiondef(v_function_oid);
  v_updated_definition := regexp_replace(
    v_definition,
    'p_downpayment_applied[[:space:]]+numeric[[:space:]]+default[[:space:]]+0',
    'p_downpayment_applied numeric default 0, p_allow_unfunded_downpayment boolean default false',
    1,
    1,
    'i'
  );
  v_updated_definition := regexp_replace(
    v_updated_definition,
    'if[[:space:]]+v_committed_downpayment[[:space:]]*\+[[:space:]]*p_downpayment_applied[[:space:]]*>[[:space:]]*v_reservation\.downpayment[[:space:]]+then',
    'if not p_allow_unfunded_downpayment and v_committed_downpayment + p_downpayment_applied > v_reservation.downpayment then',
    1,
    1,
    'i'
  );

  if v_updated_definition = v_definition
     or position('p_allow_unfunded_downpayment' in v_updated_definition) = 0 then
    raise exception 'unable_to_patch_prepare_reservation_shipment_for_release_downpayment';
  end if;

  execute v_updated_definition;
end;
$migration$;

grant execute on function public.prepare_reservation_shipment(
  uuid, jsonb, numeric, boolean
) to authenticated;

do $migration$
declare
  v_function_oid oid;
  v_definition text;
  v_updated_definition text;
begin
  v_function_oid := to_regprocedure(
    'public.release_reservation_items(uuid,jsonb,timestamptz,numeric,text)'
  );

  if v_function_oid is null then
    raise exception 'required_release_reservation_items_function_not_found';
  end if;

  v_definition := pg_get_functiondef(v_function_oid);
  v_updated_definition := replace(
    v_definition,
    $old$  if v_notes is not null and char_length(v_notes) > 2000 then$old$,
    $new$  if p_downpayment_applied is null or p_downpayment_applied <= 0 then
    raise exception 'downpayment_required' using errcode = 'P0001';
  end if;

  if v_notes is not null and char_length(v_notes) > 2000 then$new$
  );
  v_updated_definition := replace(
    v_updated_definition,
    $old$  v_prepared := public.prepare_reservation_shipment(
    p_reservation_id,
    p_items,
    p_downpayment_applied
  );$old$,
    $new$  v_prepared := public.prepare_reservation_shipment(
    p_reservation_id,
    p_items,
    p_downpayment_applied,
    true
  );$new$
  );

  if v_updated_definition = v_definition
     or position('downpayment_required' in v_updated_definition) = 0
     or position('p_allow_unfunded_downpayment' in v_updated_definition) = 0 then
    raise exception 'unable_to_patch_release_reservation_items_for_cod_downpayment';
  end if;

  execute v_updated_definition;
end;
$migration$;

commit;
