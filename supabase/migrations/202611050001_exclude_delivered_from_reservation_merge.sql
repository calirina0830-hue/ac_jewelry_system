begin;

-- Delivered reservations preserve their financial status (reserved or paid),
-- so status alone cannot identify an active reservation. New reservations must
-- never be merged into an order that already has delivered_at recorded.
do $migration$
declare
  v_function_oid oid;
  v_definition text;
  v_updated_definition text;
begin
  v_function_oid := to_regprocedure(
    'public.create_reservation_with_downpayment(uuid,numeric,numeric,text,jsonb)'
  );

  if v_function_oid is null then
    raise exception 'required_create_reservation_with_downpayment_function_not_found';
  end if;

  v_definition := pg_get_functiondef(v_function_oid);
  if position('reservation.delivered_at is null' in lower(v_definition)) > 0 then
    return;
  end if;

  v_updated_definition := regexp_replace(
    v_definition,
    '([[:space:]]+and[[:space:]]+reservation\.status[[:space:]]*=[[:space:]]*''reserved''[[:space:]]*\n[[:space:]]+and[[:space:]]+reservation\.archived_at[[:space:]]+is[[:space:]]+null[[:space:]]*\n)',
    '\1    and reservation.delivered_at is null' || chr(10),
    1,
    1,
    'i'
  );

  if v_updated_definition = v_definition then
    raise exception 'unable_to_patch_reservation_merge_delivery_guard';
  end if;

  execute v_updated_definition;
end;
$migration$;

commit;
