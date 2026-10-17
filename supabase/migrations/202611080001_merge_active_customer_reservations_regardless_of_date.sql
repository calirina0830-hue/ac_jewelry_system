begin;

-- Keep one active reservation/invoice per customer regardless of the dates on
-- the individual items. The reservation's reserved_at remains the earliest
-- reservation date, while reservation_items.ordered_at keeps each item's date.
-- Fully committed, cancelled, and archived reservations remain separate.

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
  v_reservation public.reservations%rowtype;
  v_total_paid numeric(12, 2);
  v_balance numeric(12, 2);
  v_new_status text;
  v_now timestamptz := timezone('utc', now());
begin
  -- Serialize additions for one customer so simultaneous submissions cannot
  -- create separate active reservation numbers.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_customer_id::text, 0)
  );

  select reservation.id
  into v_existing_id
  from public.reservations as reservation
  where reservation.customer_id = p_customer_id
    and (
      reservation.status in ('reserved', 'paid')
      or (
        reservation.status = 'delivered'
        and exists (
          select 1
          from public.reservation_items as existing_item
          where existing_item.reservation_id = reservation.id
            and existing_item.quantity > public.reservation_item_committed_quantity(existing_item.id)
        )
      )
    )
    and reservation.archived_at is null
    and exists (
      select 1
      from public.reservation_items as existing_item
      where existing_item.reservation_id = reservation.id
        and existing_item.quantity > public.reservation_item_committed_quantity(existing_item.id)
    )
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

    -- The temporary reservation is an implementation detail; retain the
    -- existing reservation's history and number.
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

  -- Reconcile the financial status from the complete active payment ledger.
  -- This also changes a previously paid reservation back to Reserved when the
  -- newly added items create a balance.
  select reservation.*
  into v_reservation
  from public.reservations as reservation
  where reservation.id = v_created_id
  for update;

  select coalesce(sum(payment.amount), 0)::numeric(12, 2)
  into v_total_paid
  from public.reservation_payments as payment
  where payment.reservation_id = v_created_id
    and payment.voided_at is null;

  if v_total_paid < 0 then
    raise exception 'deduction_exceeds_paid' using errcode = 'P0001';
  end if;
  if v_total_paid > v_reservation.total then
    raise exception 'payment_exceeds_balance' using errcode = 'P0001';
  end if;

  v_balance := v_reservation.total - v_total_paid;
  v_new_status := case when v_balance = 0 then 'paid' else 'reserved' end;

  update public.reservations
  set
    balance = v_balance,
    status = v_new_status,
    paid_at = case when v_new_status = 'paid' then coalesce(v_reservation.paid_at, v_now) else null end,
    updated_at = v_now
  where id = v_created_id;

  if v_reservation.status::text is distinct from v_new_status then
    insert into public.reservation_status_history (
      reservation_id,
      old_status,
      new_status,
      changed_by,
      changed_at,
      reason
    ) values (
      v_created_id,
      v_reservation.status,
      v_new_status,
      v_user_id,
      v_now,
      case
        when v_new_status = 'paid' then 'Reservation created or extended; recorded payments cover the total.'
        else 'Reservation created or extended; recorded payments leave a balance due.'
      end
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

-- Consolidate duplicate active records already present. The earliest record is
-- retained so the single row/invoice displays the earliest reservation date.
do $migration$
declare
  v_group record;
  v_target_id uuid;
  v_duplicate record;
  v_total_paid numeric(12, 2);
  v_combined_total numeric(12, 2);
begin
  for v_group in
    select reservation.customer_id
    from public.reservations as reservation
    where reservation.archived_at is null
      and (
        reservation.status in ('reserved', 'paid')
        or (
          reservation.status = 'delivered'
          and exists (
            select 1
            from public.reservation_items as item
            where item.reservation_id = reservation.id
              and item.quantity > public.reservation_item_committed_quantity(item.id)
          )
        )
      )
      and exists (
        select 1
        from public.reservation_items as item
        where item.reservation_id = reservation.id
          and item.quantity > public.reservation_item_committed_quantity(item.id)
      )
    group by reservation.customer_id
    having count(*) > 1
  loop
    select reservation.id
    into v_target_id
    from public.reservations as reservation
    where reservation.customer_id = v_group.customer_id
      and reservation.archived_at is null
      and (
        reservation.status in ('reserved', 'paid')
        or (
          reservation.status = 'delivered'
          and exists (
            select 1
            from public.reservation_items as item
            where item.reservation_id = reservation.id
              and item.quantity > public.reservation_item_committed_quantity(item.id)
          )
        )
      )
      and exists (
        select 1
        from public.reservation_items as item
        where item.reservation_id = reservation.id
          and item.quantity > public.reservation_item_committed_quantity(item.id)
      )
    order by reservation.reserved_at, reservation.created_at, reservation.id
    limit 1
    for update;

    for v_duplicate in
      select reservation.*
      from public.reservations as reservation
      where reservation.customer_id = v_group.customer_id
        and reservation.archived_at is null
        and (
          reservation.status in ('reserved', 'paid')
          or (
            reservation.status = 'delivered'
            and exists (
              select 1
              from public.reservation_items as item
              where item.reservation_id = reservation.id
                and item.quantity > public.reservation_item_committed_quantity(item.id)
            )
          )
        )
        and reservation.id <> v_target_id
        and exists (
          select 1
          from public.reservation_items as item
          where item.reservation_id = reservation.id
            and item.quantity > public.reservation_item_committed_quantity(item.id)
        )
      order by reservation.reserved_at, reservation.created_at, reservation.id
      for update
    loop
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
        reserved_at = least(target.reserved_at, v_duplicate.reserved_at),
        delivered_at = coalesce(target.delivered_at, v_duplicate.delivered_at),
        paid_at = coalesce(target.paid_at, v_duplicate.paid_at),
        pricing_complete = target.pricing_complete and v_duplicate.pricing_complete,
        notes = case
          when nullif(btrim(target.notes), '') is null then v_duplicate.notes
          when nullif(btrim(v_duplicate.notes), '') is null
            or target.notes = v_duplicate.notes then target.notes
          else left(target.notes || E'\n' || v_duplicate.notes, 4000)
        end
      where target.id = v_target_id;

      select target.total
      into v_combined_total
      from public.reservations as target
      where target.id = v_target_id;

      select coalesce(sum(payment.amount), 0)::numeric(12, 2)
      into v_total_paid
      from public.reservation_payments as payment
      where payment.reservation_id = v_target_id
        and payment.voided_at is null;

      update public.reservations
      set
        balance = v_combined_total - v_total_paid,
        status = case when v_total_paid = v_combined_total then 'paid' else 'reserved' end,
        paid_at = case
          when v_total_paid = v_combined_total then coalesce(paid_at, timezone('utc', now()))
          else null
        end
      where id = v_target_id;

      delete from public.reservations
      where id = v_duplicate.id;
    end loop;
  end loop;
end;
$migration$;

commit;
