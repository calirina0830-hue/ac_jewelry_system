begin;

-- The applied downpayment is typed per release and limited to what the
-- customer has left, so a customer with no downpayment left releases at
-- ₱0.00 applied and pays the full value as COD.
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
  v_updated_definition := regexp_replace(
    v_definition,
    'p_downpayment_applied[[:space:]]+is[[:space:]]+null[[:space:]]+or[[:space:]]+p_downpayment_applied[[:space:]]*<=[[:space:]]*0',
    'p_downpayment_applied is null or p_downpayment_applied < 0',
    1,
    1,
    'i'
  );

  if v_updated_definition = v_definition then
    raise exception 'unable_to_patch_release_reservation_items_for_zero_downpayment';
  end if;

  execute v_updated_definition;
end;
$migration$;

commit;
