begin;

-- Stock quantity no longer limits reservations anywhere else in the system.
-- The live import still refused any item whose legacy quantity was used up
-- (insufficient_stock), which blocked imports that reuse an existing item code.
do $migration$
declare
  v_function_oid oid;
  v_definition text;
  v_updated_definition text;
begin
  v_function_oid := to_regprocedure(
    'public.confirm_live_order_import(text,text,text,jsonb)'
  );

  if v_function_oid is null then
    raise exception 'required_confirm_live_order_import_function_not_found';
  end if;

  v_definition := pg_get_functiondef(v_function_oid);

  -- Already removed: nothing to do, so this script is safe to run again.
  if position('insufficient_stock' in v_definition) = 0 then
    return;
  end if;

  v_updated_definition := regexp_replace(
    v_definition,
    'if[[:space:]]+v_available[[:space:]]*<[[:space:]]*1[[:space:]]+then[[:space:]]+raise[[:space:]]+exception[[:space:]]+''insufficient_stock:%:%''[[:space:]]*,[[:space:]]*v_stock_id[[:space:]]*,[[:space:]]*v_available[[:space:]]+using[[:space:]]+errcode[[:space:]]*=[[:space:]]*''P0001''[[:space:]]*;[[:space:]]+end[[:space:]]+if[[:space:]]*;',
    '',
    'i'
  );

  if v_updated_definition = v_definition
     or position('insufficient_stock' in v_updated_definition) > 0 then
    raise exception 'unable_to_remove_live_import_stock_limit';
  end if;

  execute v_updated_definition;
end;
$migration$;

commit;
