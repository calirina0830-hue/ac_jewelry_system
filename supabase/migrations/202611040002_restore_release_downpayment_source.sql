begin;

-- The release flow uses reservations.downpayment as its available release
-- allowance. Restore that rule if the previous ledger-based patch was applied.
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
    'v_committed_downpayment[[:space:]]*\+[[:space:]]*p_downpayment_applied[[:space:]]*>[[:space:]]*v_total_paid',
    'v_committed_downpayment + p_downpayment_applied > v_reservation.downpayment',
    1,
    1,
    'i'
  );
  v_updated_definition := regexp_replace(
    v_updated_definition,
    'v_total_paid,',
    'v_reservation.downpayment,',
    1,
    1,
    'i'
  );

  if v_updated_definition <> v_definition then
    execute v_updated_definition;
  end if;
end;
$migration$;

commit;
