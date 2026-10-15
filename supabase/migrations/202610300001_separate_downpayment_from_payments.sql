begin;

-- Downpayment is a separately stored reservation amount. Active payment rows
-- determine amount paid, remaining balance, and whether the reservation is Paid.
drop trigger if exists reservation_payments_sync_totals_from_ledger
  on public.reservation_payments;
drop trigger if exists reservations_sync_totals_from_payment_ledger
  on public.reservations;
drop function if exists public.sync_reservation_payment_totals_from_ledger();

-- Balance now follows the active payment ledger, not the separately recorded
-- downpayment value.
alter table public.reservations
  drop constraint if exists reservations_balance_consistent;

-- Preserve the existing, validated payment RPC behavior but stop overwriting
-- the downpayment field when payments are recorded, corrected, deleted, or
-- reverted. This keeps all other authorization and payment rules unchanged.
do $migration$
declare
  v_patch record;
  v_definition text;
  v_definition_lines text[];
  v_updated_definition text;
  v_line_index integer;
  v_line text;
  v_indent text;
  v_has_trailing_comma boolean;
  v_assignment_count integer;
  v_guard_count integer;
begin
  for v_patch in
    select patch.function_oid
    from (values
      (
        to_regprocedure('public.record_reservation_payment(uuid,timestamptz,numeric,text,text,text,jsonb)')
      ),
      (
        to_regprocedure('public.edit_reservation_payment(uuid,timestamptz,timestamptz,numeric,text,text,text)')
      ),
      (
        to_regprocedure('public.delete_reservation_payment(uuid,timestamptz,timestamptz)')
      ),
      (
        to_regprocedure('public.bulk_revert_paid_reservations(uuid[],text)')
      )
    ) as patch(function_oid)
  loop
    if v_patch.function_oid is null then
      raise exception 'required_payment_function_not_found';
    end if;

    v_definition := pg_get_functiondef(v_patch.function_oid);
    v_definition_lines := string_to_array(v_definition, E'\n');
    v_assignment_count := 0;

    -- Preserve SET-list syntax across function versions by replacing the
    -- downpayment expression with a self-assignment, keeping its comma if any.
    for v_line_index in 1..coalesce(array_length(v_definition_lines, 1), 0) loop
      v_line := v_definition_lines[v_line_index];
      if v_line ~ '^[[:blank:]]*downpayment[[:blank:]]*=' then
        if v_line ~* '^[[:blank:]]*downpayment[[:blank:]]*=[[:blank:]]*downpayment[[:blank:]]*,?[[:blank:]]*$' then
          continue;
        end if;

        v_indent := substring(v_line from '^[[:blank:]]*');
        v_has_trailing_comma := right(rtrim(v_line, ' ' || chr(9) || chr(13)), 1) = ',';
        v_definition_lines[v_line_index] := v_indent || 'downpayment = downpayment' ||
          case when v_has_trailing_comma then ',' else '' end;
        v_assignment_count := v_assignment_count + 1;
      end if;
    end loop;

    if v_assignment_count > 0 then
      v_updated_definition := array_to_string(v_definition_lines, E'\n');
      execute v_updated_definition;
    end if;
  end loop;

  -- Release commitments are backed by reservations.downpayment, not by the
  -- independently maintained payment ledger. Do not block a payment correction
  -- merely because recorded payments are below an amount already applied from
  -- the downpayment pool to released items.
  for v_patch in
    select patch.function_oid
    from (values
      (
        to_regprocedure('public.edit_reservation_payment(uuid,timestamptz,timestamptz,numeric,text,text,text)')
      ),
      (
        to_regprocedure('public.delete_reservation_payment(uuid,timestamptz,timestamptz)')
      )
    ) as patch(function_oid)
  loop
    if v_patch.function_oid is null then
      raise exception 'required_payment_function_not_found';
    end if;

    v_definition := pg_get_functiondef(v_patch.function_oid);
    v_definition_lines := string_to_array(v_definition, E'\n');
    v_guard_count := 0;

    for v_line_index in 1..coalesce(array_length(v_definition_lines, 1), 0) loop
      v_line := v_definition_lines[v_line_index];
      if v_line ~* '^[[:blank:]]*if[[:blank:]]+v_total_paid[[:blank:]]*<[[:blank:]]*v_committed[[:blank:]]+then[[:blank:]]*$' then
        if v_line_index + 2 > array_length(v_definition_lines, 1)
           or v_definition_lines[v_line_index + 1] !~* '^[[:blank:]]*raise[[:blank:]]+exception[[:blank:]]+''downpayment_below_committed'''
           or v_definition_lines[v_line_index + 2] !~* '^[[:blank:]]*end[[:blank:]]+if;[[:blank:]]*$' then
          raise exception 'unexpected_payment_commitment_check:%',
            v_patch.function_oid::regprocedure;
        end if;

        v_definition_lines[v_line_index] := '';
        v_definition_lines[v_line_index + 1] := '';
        v_definition_lines[v_line_index + 2] := '';
        v_guard_count := v_guard_count + 1;
      elsif v_line ~* '^[[:blank:]]*if[[:blank:]]+v_total_paid[[:blank:]]*<[[:blank:]]*v_committed' then
        raise exception 'unexpected_payment_commitment_check:%',
          v_patch.function_oid::regprocedure;
      end if;
    end loop;

    if v_guard_count > 0 then
      v_updated_definition := array_to_string(v_definition_lines, E'\n');
      execute v_updated_definition;
    end if;
  end loop;
end;
$migration$;

-- Reservation edits keep the user-entered downpayment independent of payments.
-- Recalculate the balance and payment status from active ledger rows after the
-- existing RPC validates and persists the customer's items and totals.
create or replace function public.update_reservation_with_payment_adjustment(
  p_reservation_id uuid,
  p_expected_updated_at timestamptz,
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
  v_reservation_id uuid;
  v_reservation public.reservations%rowtype;
  v_previous_status text;
  v_total_paid numeric(12, 2);
  v_balance numeric(12, 2);
  v_new_status text;
  v_committed numeric(12, 2);
  v_now timestamptz := timezone('utc', now());
begin
  v_committed := public.reservation_downpayment_committed(p_reservation_id);
  if p_downpayment < v_committed then
    raise exception 'downpayment_below_committed:%', v_committed
      using errcode = 'P0001';
  end if;

  select reservation.status::text
  into v_previous_status
  from public.reservations as reservation
  where reservation.id = p_reservation_id
  for update;

  if not found then
    raise exception 'reservation_not_found' using errcode = 'P0001';
  end if;

  v_reservation_id := public.update_reservation(
    p_reservation_id,
    p_expected_updated_at,
    p_customer_id,
    p_discount,
    p_downpayment,
    p_notes,
    p_items
  );

  select reservation.*
  into v_reservation
  from public.reservations as reservation
  where reservation.id = v_reservation_id;

  select coalesce(sum(payment.amount), 0)::numeric(12, 2)
  into v_total_paid
  from public.reservation_payments as payment
  where payment.reservation_id = v_reservation_id
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
    paid_at = case
      when v_new_status = 'paid' then coalesce(v_reservation.paid_at, v_now)
      else null
    end,
    updated_at = v_now
  where id = v_reservation_id;

  if v_previous_status is distinct from v_new_status then
    insert into public.reservation_status_history (
      reservation_id,
      old_status,
      new_status,
      changed_by,
      changed_at,
      reason
    ) values (
      v_reservation_id,
      v_previous_status,
      v_new_status,
      v_user_id,
      v_now,
      case
        when v_new_status = 'paid' then 'Reservation updated; recorded payments cover the total.'
        else 'Reservation updated; recorded payments leave a balance due.'
      end
    );
  end if;

  return v_reservation_id;
end;
$function$;

revoke all on function public.update_reservation_with_payment_adjustment(
  uuid, timestamptz, uuid, numeric, numeric, text, jsonb
) from public, anon;
grant execute on function public.update_reservation_with_payment_adjustment(
  uuid, timestamptz, uuid, numeric, numeric, text, jsonb
) to authenticated;

-- Preserve the customer's single active reservation number behavior while
-- syncing only the balance/status from recorded payments. The downpayment is
-- still stored as the amount entered for this reservation/addition.
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
    paid_at = case when v_new_status = 'paid' then v_now else null end,
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

-- Bring existing balances/statuses in line with their recorded payments while
-- leaving the downpayment column untouched. Delivered and Cancelled stay as-is.
with active_totals as (
  select
    reservation.id,
    reservation.status,
    reservation.paid_at,
    reservation.total,
    coalesce(sum(payment.amount) filter (where payment.voided_at is null), 0)
      as active_paid
  from public.reservations as reservation
  left join public.reservation_payments as payment
    on payment.reservation_id = reservation.id
  where reservation.archived_at is null
    and reservation.status in ('reserved', 'paid')
    and reservation.delivered_at is null
    and not exists (
      select 1
      from public.reservation_shipments as shipment
      where shipment.reservation_id = reservation.id
        and shipment.status = 'shipped'
    )
  group by reservation.id
),
transitions as (
  select
    active.id,
    active.status as old_status,
    case when active.active_paid = active.total then 'paid' else 'reserved' end
      as new_status
  from active_totals as active
  where active.active_paid between 0 and active.total
    and active.status::text is distinct from
      case when active.active_paid = active.total then 'paid' else 'reserved' end
)
insert into public.reservation_status_history (
  reservation_id,
  old_status,
  new_status,
  changed_at,
  reason
)
select
  transition.id,
  transition.old_status,
  transition.new_status,
  timezone('utc', now()),
  'Reservation payment status aligned with the active payment ledger.'
from transitions as transition;

with active_totals as (
  select
    reservation.id,
    reservation.total,
    coalesce(sum(payment.amount) filter (where payment.voided_at is null), 0)
      as active_paid
  from public.reservations as reservation
  left join public.reservation_payments as payment
    on payment.reservation_id = reservation.id
  where reservation.archived_at is null
    and reservation.status in ('reserved', 'paid')
    and reservation.delivered_at is null
    and not exists (
      select 1
      from public.reservation_shipments as shipment
      where shipment.reservation_id = reservation.id
        and shipment.status = 'shipped'
    )
  group by reservation.id, reservation.total
)
update public.reservations as reservation
set
  balance = active.total - active.active_paid,
  status = case when active.active_paid = active.total then 'paid' else 'reserved' end,
  paid_at = case
    when active.active_paid = active.total then coalesce(reservation.paid_at, timezone('utc', now()))
    else null
  end,
  updated_at = timezone('utc', now())
from active_totals as active
where active.id = reservation.id
  and active.active_paid between 0 and active.total
  and (
    reservation.balance is distinct from active.total - active.active_paid
    or reservation.status::text is distinct from
      case when active.active_paid = active.total then 'paid' else 'reserved' end
  );

commit;
