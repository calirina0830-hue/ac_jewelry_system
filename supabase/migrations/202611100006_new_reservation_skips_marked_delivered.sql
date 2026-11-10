begin;

-- A new order must not join a reservation that was marked delivered by hand.
-- A release also sets delivered_at, so an order with a confirmed release and
-- items still waiting remains open and keeps receiving new items.
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

  if position('reservation.delivered_at is null' in v_definition) > 0 then
    return;
  end if;

  v_updated_definition := regexp_replace(
    v_definition,
    'and[[:space:]]+reservation\.archived_at[[:space:]]+is[[:space:]]+null',
    E'and reservation.archived_at is null\n'
    || E'    and (\n'
    || E'      reservation.delivered_at is null\n'
    || E'      or exists (\n'
    || E'        select 1\n'
    || E'        from public.reservation_shipments as shipment\n'
    || E'        where shipment.reservation_id = reservation.id\n'
    || E'          and shipment.status = ''shipped''\n'
    || E'      )\n'
    || E'    )',
    1,
    1,
    'i'
  );

  if v_updated_definition = v_definition then
    raise exception 'unable_to_patch_create_reservation_with_downpayment';
  end if;

  execute v_updated_definition;
end;
$migration$;

commit;
