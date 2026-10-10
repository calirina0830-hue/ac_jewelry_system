begin;

-- Older versions represented delivery by replacing the payment status. Preserve
-- the delivery timestamp while restoring Paid as the financial status.
update public.reservations
set status = 'paid'
where status = 'delivered'
  and delivered_at is not null;

create or replace function public.transition_reservation_status(
  p_reservation_id uuid,
  p_new_status text,
  p_expected_updated_at timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_role public.profile_role;
  v_reservation public.reservations%rowtype;
  v_now timestamptz := timezone('utc', now());
  v_allowed boolean := false;
begin
  if v_user_id is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  v_role := public.current_profile_role();
  if v_role not in ('admin', 'staff') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  if p_new_status not in ('reserved', 'paid', 'delivered', 'cancelled') then
    raise exception 'invalid_status' using errcode = 'P0001';
  end if;

  select reservation.*
  into v_reservation
  from public.reservations as reservation
  where reservation.id = p_reservation_id
  for update;

  if not found then
    raise exception 'reservation_not_found' using errcode = 'P0001';
  end if;
  if v_reservation.archived_at is not null then
    raise exception 'reservation_archived' using errcode = 'P0001';
  end if;
  if v_reservation.updated_at is distinct from p_expected_updated_at then
    raise exception 'stale_reservation' using errcode = 'P0001';
  end if;

  v_allowed :=
    (
      v_reservation.status in ('reserved', 'paid')
      and p_new_status = 'delivered'
      and v_reservation.delivered_at is null
    )
    or (
      v_role = 'admin'
      and v_reservation.status = 'reserved'
      and p_new_status = 'cancelled'
    );

  if not v_allowed then
    if p_new_status = 'delivered' and v_reservation.delivered_at is not null then
      raise exception 'already_delivered' using errcode = 'P0001';
    end if;
    raise exception 'invalid_status_transition:%:%',
      v_reservation.status,
      p_new_status
      using errcode = 'P0001';
  end if;

  update public.reservations
  set
    status = case
      when p_new_status = 'delivered' then v_reservation.status
      else p_new_status
    end,
    delivered_at = case
      when p_new_status = 'delivered' then v_now
      else delivered_at
    end,
    cancelled_at = case
      when p_new_status = 'cancelled' then v_now
      else cancelled_at
    end,
    updated_at = v_now
  where id = p_reservation_id;

  insert into public.reservation_status_history (
    reservation_id,
    old_status,
    new_status,
    changed_by,
    changed_at,
    reason
  )
  values (
    p_reservation_id,
    v_reservation.status,
    p_new_status,
    v_user_id,
    v_now,
    case
      when p_new_status = 'delivered' then 'Reservation marked delivered'
      else null
    end
  );

  return p_reservation_id;
end;
$function$;

revoke all on function public.transition_reservation_status(uuid, text, timestamptz)
  from public, anon;
grant execute on function public.transition_reservation_status(uuid, text, timestamptz)
  to authenticated;

create or replace function public.bulk_transition_reservations(
  p_reservation_ids uuid[],
  p_new_status text
)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_role public.profile_role;
  v_id uuid;
  v_old_status text;
  v_now timestamptz := timezone('utc', now());
begin
  if v_user_id is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  v_role := public.current_profile_role();
  if v_role not in ('admin', 'staff') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if coalesce(array_length(p_reservation_ids, 1), 0) < 1
     or array_length(p_reservation_ids, 1) > 100
     or (
       select count(distinct value)
       from unnest(p_reservation_ids) as selected(value)
     ) <> array_length(p_reservation_ids, 1) then
    raise exception 'invalid_bulk_selection' using errcode = 'P0001';
  end if;
  if p_new_status = 'cancelled' and v_role <> 'admin' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_new_status not in ('cancelled', 'delivered') then
    raise exception 'invalid_status' using errcode = 'P0001';
  end if;

  perform reservation.id
  from public.reservations as reservation
  where reservation.id = any(p_reservation_ids)
  order by reservation.id
  for update;

  if p_new_status = 'cancelled' then
    if (
      select count(*)
      from public.reservations
      where id = any(p_reservation_ids)
        and archived_at is null
        and status = 'reserved'
    ) <> array_length(p_reservation_ids, 1) then
      raise exception 'invalid_bulk_transition' using errcode = 'P0001';
    end if;
  elsif (
    select count(*)
    from public.reservations
    where id = any(p_reservation_ids)
      and archived_at is null
      and status in ('reserved', 'paid')
      and delivered_at is null
  ) <> array_length(p_reservation_ids, 1) then
    raise exception 'invalid_bulk_transition' using errcode = 'P0001';
  end if;

  foreach v_id in array p_reservation_ids loop
    select status into v_old_status
    from public.reservations
    where id = v_id;

    update public.reservations
    set
      status = case
        when p_new_status = 'delivered' then status
        else p_new_status
      end,
      cancelled_at = case
        when p_new_status = 'cancelled' then v_now
        else cancelled_at
      end,
      delivered_at = case
        when p_new_status = 'delivered' then v_now
        else delivered_at
      end,
      updated_at = v_now
    where id = v_id;

    insert into public.reservation_status_history (
      reservation_id,
      old_status,
      new_status,
      changed_by,
      changed_at,
      reason
    )
    values (
      v_id,
      v_old_status,
      p_new_status,
      v_user_id,
      v_now,
      case
        when p_new_status = 'delivered' then 'Reservation marked delivered'
        else null
      end
    );
  end loop;

  return array_length(p_reservation_ids, 1);
end;
$function$;

revoke all on function public.bulk_transition_reservations(uuid[], text)
  from public, anon;
grant execute on function public.bulk_transition_reservations(uuid[], text)
  to authenticated;

create or replace function public.update_reservation_invoice_notes(
  p_reservation_id uuid,
  p_expected_updated_at timestamptz,
  p_notes text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_reservation public.reservations%rowtype;
  v_now timestamptz := timezone('utc', now());
begin
  if auth.uid() is null
     or public.current_profile_role() not in ('admin', 'staff') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  if char_length(coalesce(p_notes, '')) > 4000 then
    raise exception 'invalid_notes' using errcode = 'P0001';
  end if;

  select reservation.*
  into v_reservation
  from public.reservations as reservation
  where reservation.id = p_reservation_id
  for update;

  if not found then
    raise exception 'reservation_not_found' using errcode = 'P0001';
  end if;
  if v_reservation.archived_at is not null then
    raise exception 'reservation_archived' using errcode = 'P0001';
  end if;
  if v_reservation.updated_at is distinct from p_expected_updated_at then
    raise exception 'stale_reservation' using errcode = 'P0001';
  end if;

  update public.reservations
  set
    notes = nullif(btrim(p_notes), ''),
    updated_at = v_now
  where id = p_reservation_id;

  return p_reservation_id;
end;
$function$;

revoke all on function public.update_reservation_invoice_notes(uuid, timestamptz, text)
  from public, anon;
grant execute on function public.update_reservation_invoice_notes(uuid, timestamptz, text)
  to authenticated;

create or replace function public.get_reservation_category_metrics()
returns table (
  category text,
  reserved_quantity bigint,
  paid_quantity bigint,
  delivered_quantity bigint,
  cancelled_quantity bigint,
  total_quantity bigint,
  committed_value numeric
)
language sql
stable
security invoker
set search_path = ''
as $function$
  with categories(category, position) as (
    values
      ('Ring'::text, 1),
      ('Necklace'::text, 2),
      ('Bracelet'::text, 3),
      ('Earrings'::text, 4),
      ('Pendant'::text, 5),
      ('Anklet'::text, 6),
      ('Watch'::text, 7),
      ('Set'::text, 8),
      ('Others'::text, 9)
  )
  select
    categories.category,
    coalesce(sum(items.quantity) filter (
      where reservation.status = 'reserved' and reservation.archived_at is null
    ), 0)::bigint as reserved_quantity,
    coalesce(sum(items.quantity) filter (
      where reservation.status = 'paid' and reservation.archived_at is null
    ), 0)::bigint as paid_quantity,
    coalesce(sum(items.quantity) filter (
      where reservation.delivered_at is not null and reservation.archived_at is null
    ), 0)::bigint as delivered_quantity,
    coalesce(sum(items.quantity) filter (
      where reservation.status = 'cancelled' and reservation.archived_at is null
    ), 0)::bigint as cancelled_quantity,
    coalesce(sum(items.quantity) filter (
      where reservation.archived_at is null
    ), 0)::bigint as total_quantity,
    coalesce(sum(items.line_total) filter (
      where reservation.status in ('reserved', 'paid')
        and reservation.archived_at is null
    ), 0)::numeric as committed_value
  from categories
  left join public.reservation_items as items
    on items.category = categories.category
  left join public.reservations as reservation
    on reservation.id = items.reservation_id
  group by categories.category, categories.position
  order by categories.position;
$function$;

revoke all on function public.get_reservation_category_metrics()
  from public, anon;
grant execute on function public.get_reservation_category_metrics()
  to authenticated;

create or replace function public.get_dashboard_metrics()
returns table (
  total_customers bigint,
  active_stock_items bigint,
  total_units bigint,
  low_stock_items bigint,
  active_reservations bigint,
  reserved_count bigint,
  paid_count bigint,
  delivered_count bigint,
  cancelled_count bigint,
  reserved_value numeric,
  paid_value numeric,
  outstanding_balance numeric
)
language sql
stable
security invoker
set search_path = ''
as $function$
  select
    (
      select count(*)
      from public.customers
      where archived_at is null
    ) as total_customers,
    (
      select count(*)
      from public.stock_items
      where archived_at is null and is_active
    ) as active_stock_items,
    (
      select coalesce(sum(quantity), 0)
      from public.stock_items
      where archived_at is null and is_active
    ) as total_units,
    (
      select count(*)
      from public.stock_items
      where archived_at is null and is_active and quantity <= 5
    ) as low_stock_items,
    (
      select count(*)
      from public.reservations
      where archived_at is null and status in ('reserved', 'paid')
    ) as active_reservations,
    (
      select count(*)
      from public.reservations
      where archived_at is null and status = 'reserved'
    ) as reserved_count,
    (
      select count(*)
      from public.reservations
      where archived_at is null and status = 'paid'
    ) as paid_count,
    (
      select count(*)
      from public.reservations
      where archived_at is null and delivered_at is not null
    ) as delivered_count,
    (
      select count(*)
      from public.reservations
      where archived_at is null and status = 'cancelled'
    ) as cancelled_count,
    (
      select coalesce(sum(total), 0)
      from public.reservations
      where archived_at is null and status = 'reserved'
    ) as reserved_value,
    (
      select coalesce(sum(total), 0)
      from public.reservations
      where archived_at is null and status = 'paid'
    ) as paid_value,
    (
      select coalesce(sum(balance), 0)
      from public.reservations
      where archived_at is null and status = 'reserved'
    ) as outstanding_balance;
$function$;

revoke all on function public.get_dashboard_metrics() from public;
grant execute on function public.get_dashboard_metrics() to authenticated;

commit;
