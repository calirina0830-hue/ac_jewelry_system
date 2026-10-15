begin;

-- Collapse existing active duplicate rows before future manual reservations
-- start reusing the customer's current Reserved reservation. Items remain
-- separate lines, but they all belong to one reservation number.
do $migration$
declare
  v_group record;
  v_target_id uuid;
  v_duplicate record;
begin
  for v_group in
    select reservation.customer_id, reservation.status
    from public.reservations as reservation
    where reservation.archived_at is null
      and reservation.status in ('reserved', 'paid')
    group by reservation.customer_id, reservation.status
    having count(*) > 1
  loop
    select reservation.id
    into v_target_id
    from public.reservations as reservation
    where reservation.customer_id = v_group.customer_id
      and reservation.status = v_group.status
      and reservation.archived_at is null
    order by reservation.reserved_at, reservation.created_at, reservation.id
    limit 1
    for update;

    for v_duplicate in
      select reservation.*
      from public.reservations as reservation
      where reservation.customer_id = v_group.customer_id
        and reservation.status = v_group.status
        and reservation.archived_at is null
        and reservation.id <> v_target_id
      order by reservation.reserved_at, reservation.created_at, reservation.id
      for update
    loop
      -- The same stock item may intentionally appear on more than one line
      -- when its selling price or order date differs.
      update public.reservation_items
      set reservation_id = v_target_id
      where reservation_id = v_duplicate.id;

      update public.reservation_payments
      set reservation_id = v_target_id
      where reservation_id = v_duplicate.id;

      update public.reservation_status_history
      set reservation_id = v_target_id
      where reservation_id = v_duplicate.id;

      update public.reservation_shipments
      set reservation_id = v_target_id
      where reservation_id = v_duplicate.id;

      update public.reservations as target
      set
        subtotal = target.subtotal + v_duplicate.subtotal,
        discount = target.discount + v_duplicate.discount,
        downpayment = target.downpayment + v_duplicate.downpayment,
        total = target.total + v_duplicate.total,
        balance = target.balance + v_duplicate.balance,
        pricing_complete = target.pricing_complete and v_duplicate.pricing_complete,
        notes = case
          when nullif(btrim(target.notes), '') is null then v_duplicate.notes
          when nullif(btrim(v_duplicate.notes), '') is null
            or target.notes = v_duplicate.notes then target.notes
          else left(target.notes || E'\n' || v_duplicate.notes, 4000)
        end
      where target.id = v_target_id;

      delete from public.reservations
      where id = v_duplicate.id;
    end loop;
  end loop;
end;
$migration$;

-- Manual creation now appends the submitted items and downpayment to the
-- customer's existing active Reserved reservation. Calling create_reservation
-- first keeps all existing validation, stock locking, and trusted snapshots in
-- one place; the temporary row is merged atomically before this RPC returns.
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
  v_existing_id uuid;
  v_created_id uuid;
  v_created public.reservations%rowtype;
begin
  -- Serialize manual additions for one customer so simultaneous submissions
  -- cannot create two active reservation numbers.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_customer_id::text, 0)
  );

  select reservation.id
  into v_existing_id
  from public.reservations as reservation
  where reservation.customer_id = p_customer_id
    and reservation.status = 'reserved'
    and reservation.archived_at is null
  order by reservation.reserved_at, reservation.created_at, reservation.id
  limit 1
  for update;

  v_created_id := public.create_reservation(
    p_customer_id,
    p_discount,
    p_downpayment,
    p_notes,
    p_items
  );

  if v_existing_id is not null then
    select reservation.*
    into strict v_created
    from public.reservations as reservation
    where reservation.id = v_created_id
    for update;

    update public.reservation_items
    set reservation_id = v_existing_id
    where reservation_id = v_created_id;

    -- The temporary reservation's initial history is not a separate business
    -- event; the existing reservation simply received additional items.
    delete from public.reservation_status_history
    where reservation_id = v_created_id;

    update public.reservations as existing
    set
      subtotal = existing.subtotal + v_created.subtotal,
      discount = existing.discount + v_created.discount,
      downpayment = existing.downpayment + v_created.downpayment,
      total = existing.total + v_created.total,
      balance = existing.balance + v_created.balance,
      pricing_complete = existing.pricing_complete and v_created.pricing_complete,
      notes = case
        when nullif(btrim(existing.notes), '') is null then v_created.notes
        when nullif(btrim(v_created.notes), '') is null
          or existing.notes = v_created.notes then existing.notes
        else left(existing.notes || E'\n' || v_created.notes, 4000)
      end
    where existing.id = v_existing_id;

    delete from public.reservations
    where id = v_created_id;

    v_created_id := v_existing_id;
  end if;

  if p_downpayment > 0 then
    insert into public.reservation_payments (
      reservation_id,
      amount,
      notes,
      recorded_by
    ) values (
      v_created_id,
      p_downpayment,
      'Downpayment entered while adding reservation items.',
      v_user_id
    );
  end if;

  return v_created_id;
end;
$function$;

revoke all on function public.create_reservation_with_downpayment(
  uuid, numeric, numeric, text, jsonb
) from public, anon;
grant execute on function public.create_reservation_with_downpayment(
  uuid, numeric, numeric, text, jsonb
) to authenticated;

commit;
