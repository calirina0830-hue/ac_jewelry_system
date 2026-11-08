begin;

-- Applies one customer's edited downpayment across their reservations in a
-- single transaction, so the amounts all change together or not at all.
create or replace function public.set_reservation_paid_amounts(p_amounts jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_entry record;
  v_updated_at timestamptz;
begin
  if jsonb_typeof(p_amounts) <> 'array'
     or jsonb_array_length(p_amounts) not between 1 and 100 then
    raise exception 'invalid_payment' using errcode = 'P0001';
  end if;

  for v_entry in
    select (item.value ->> 'id')::uuid as id, (item.value ->> 'amount')::numeric as amount
    from jsonb_array_elements(p_amounts) as item(value)
    order by (item.value ->> 'id')::uuid
  loop
    select reservation.updated_at
    into v_updated_at
    from public.reservations as reservation
    where reservation.id = v_entry.id
    for update;

    if not found then
      raise exception 'reservation_not_found' using errcode = 'P0001';
    end if;

    perform public.set_reservation_paid_amount(v_entry.id, v_updated_at, v_entry.amount);
  end loop;

  return jsonb_build_object('updated', jsonb_array_length(p_amounts));
end;
$function$;

revoke all on function public.set_reservation_paid_amounts(jsonb) from public, anon;
grant execute on function public.set_reservation_paid_amounts(jsonb) to authenticated;

commit;
