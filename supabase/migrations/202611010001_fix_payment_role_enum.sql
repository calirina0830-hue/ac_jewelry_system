begin;

-- current_profile_role() returns the profile_role enum. Coalescing that value
-- directly with an empty string makes PostgreSQL cast '' to profile_role and
-- raises 22P02 before an authenticated admin or staff member can edit/delete.
-- Patch installed function bodies as a forward migration so environments that
-- already ran the original payment migrations do not need to rerun them.
do $migration$
declare
  v_function_oid regprocedure;
  v_definition text;
  v_updated_definition text;
begin
  foreach v_function_oid in array array[
    to_regprocedure(
      'public.edit_reservation_payment(uuid,timestamptz,timestamptz,numeric,text,text,text)'
    ),
    to_regprocedure(
      'public.delete_reservation_payment(uuid,timestamptz,timestamptz)'
    )
  ]
  loop
    if v_function_oid is null then
      continue;
    end if;

    v_definition := pg_get_functiondef(v_function_oid);
    v_updated_definition := replace(
      v_definition,
      'coalesce(public.current_profile_role(), '''')',
      'coalesce(public.current_profile_role()::text, '''')'
    );

    if v_updated_definition <> v_definition then
      execute v_updated_definition;
    end if;
  end loop;
end;
$migration$;

commit;
