begin;

alter table public.reservations
  add column pricing_complete boolean not null default true;

alter table public.reservation_items
  add column price_confirmed boolean not null default true;

alter table public.reservation_status_history
  add column reason text,
  add constraint reservation_status_history_reason_length
    check (reason is null or char_length(reason) <= 1000);

create table public.reservation_payments (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null
    references public.reservations (id) on delete restrict,
  amount numeric(12, 2) not null,
  payment_method text,
  reference_no text,
  evidence_path text,
  notes text,
  recorded_by uuid references auth.users (id) on delete set null,
  recorded_at timestamptz not null default timezone('utc', now()),
  voided_at timestamptz,
  voided_by uuid references auth.users (id) on delete set null,
  void_reason text,
  constraint reservation_payments_amount_positive check (amount > 0),
  constraint reservation_payments_method_length
    check (payment_method is null or char_length(payment_method) <= 120),
  constraint reservation_payments_reference_length
    check (reference_no is null or char_length(reference_no) <= 200),
  constraint reservation_payments_evidence_path_length
    check (evidence_path is null or char_length(evidence_path) <= 1024),
  constraint reservation_payments_notes_length
    check (notes is null or char_length(notes) <= 2000),
  constraint reservation_payments_void_reason_length
    check (void_reason is null or char_length(void_reason) <= 1000),
  constraint reservation_payments_void_audit_consistent
    check (
      (voided_at is null and voided_by is null and void_reason is null)
      or
      (voided_at is not null and voided_by is not null and void_reason is not null)
    )
);

create index reservation_payments_reservation_id_idx
  on public.reservation_payments (reservation_id, recorded_at);
create index reservation_payments_active_idx
  on public.reservation_payments (reservation_id)
  where voided_at is null;
create index reservation_payments_recorded_by_idx
  on public.reservation_payments (recorded_by);

revoke all on table public.reservation_payments from anon, authenticated;
grant select on table public.reservation_payments to authenticated;

alter table public.reservation_payments enable row level security;

create policy "reservation_payments_select_authenticated"
on public.reservation_payments
for select
to authenticated
using (true);

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'payment-evidence',
  'payment-evidence',
  false,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy "payment_evidence_select_authenticated"
on storage.objects
for select
to authenticated
using (bucket_id = 'payment-evidence');

create policy "payment_evidence_insert_admin_staff"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'payment-evidence'
  and (select public.current_profile_role()) in ('admin', 'staff')
  and (storage.foldername(name))[1] = (select auth.uid()::text)
  and lower(storage.extension(name)) in ('jpg', 'png', 'webp')
);

create policy "payment_evidence_delete_admin_staff"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'payment-evidence'
  and (
    (select public.current_profile_role()) = 'admin'
    or (
      (select public.current_profile_role()) = 'staff'
      and (storage.foldername(name))[1] = (select auth.uid()::text)
    )
  )
);

create or replace function public.sync_reservation_pricing_complete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_reservation_id uuid := coalesce(new.reservation_id, old.reservation_id);
  v_import_batch_id uuid;
begin
  update public.reservations
  set pricing_complete = (
    exists (
      select 1
      from public.reservation_items
      where reservation_id = v_reservation_id
    )
    and not exists (
      select 1
      from public.reservation_items
      where reservation_id = v_reservation_id
        and not price_confirmed
    )
  )
  where id = v_reservation_id;

  select import_batch_id
  into v_import_batch_id
  from public.reservations
  where id = v_reservation_id;

  if v_import_batch_id is not null then
    update public.reservation_import_batches
    set total_value = coalesce((
      select sum(reservation.total)
      from public.reservations as reservation
      where reservation.import_batch_id = v_import_batch_id
    ), 0)
    where id = v_import_batch_id;
  end if;

  return null;
end;
$function$;

revoke all on function public.sync_reservation_pricing_complete()
  from public, anon, authenticated;

create trigger reservation_items_sync_pricing_complete
after insert or update of price_confirmed or delete
on public.reservation_items
for each row execute function public.sync_reservation_pricing_complete();

create or replace function public.prepare_reservation_items(
  p_items jsonb,
  p_exclude_reservation_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_input jsonb;
  v_stock public.stock_items%rowtype;
  v_existing public.reservation_items%rowtype;
  v_stock_id uuid;
  v_item_id uuid;
  v_quantity integer;
  v_discount numeric;
  v_unit_price numeric(12, 2);
  v_line_total numeric(12, 2);
  v_subtotal numeric := 0;
  v_held integer;
  v_available integer;
  v_seen_stock_ids uuid[] := array[]::uuid[];
  v_prepared_items jsonb := '[]'::jsonb;
  v_item_name text;
  v_sku text;
  v_category text;
  v_image_path text;
begin
  if jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) < 1
     or jsonb_array_length(p_items) > 50 then
    raise exception 'invalid_reservation_items' using errcode = 'P0001';
  end if;

  begin
    perform stock.id
    from public.stock_items as stock
    where stock.id in (
      select (item.value ->> 'stock_item_id')::uuid
      from jsonb_array_elements(p_items) as item(value)
    )
    order by stock.id
    for update;
  exception
    when invalid_text_representation then
      raise exception 'invalid_reservation_items' using errcode = 'P0001';
  end;

  for v_input in
    select item.value
    from jsonb_array_elements(p_items) with ordinality as item(value, position)
    order by item.position
  loop
    if jsonb_typeof(v_input) <> 'object' then
      raise exception 'invalid_reservation_items' using errcode = 'P0001';
    end if;

    begin
      v_stock_id := nullif(v_input ->> 'stock_item_id', '')::uuid;
      v_item_id := nullif(v_input ->> 'reservation_item_id', '')::uuid;
      v_quantity := (v_input ->> 'quantity')::integer;
      v_discount := (v_input ->> 'discount')::numeric;
      v_unit_price := (v_input ->> 'selling_price')::numeric;
    exception
      when invalid_text_representation or numeric_value_out_of_range then
        raise exception 'invalid_reservation_items' using errcode = 'P0001';
    end;

    if v_stock_id is null
       or v_quantity is null
       or v_quantity <= 0
       or v_discount is null
       or v_discount = 'NaN'::numeric
       or v_discount < 0
       or v_discount > 9999999999.99
       or v_discount <> round(v_discount, 2)
       or v_unit_price is null
       or v_unit_price = 'NaN'::numeric
       or v_unit_price < 0
       or v_unit_price > 9999999999.99
       or v_unit_price <> round(v_unit_price, 2) then
      raise exception 'invalid_reservation_items' using errcode = 'P0001';
    end if;

    if v_stock_id = any(v_seen_stock_ids) then
      raise exception 'duplicate_stock_item' using errcode = 'P0001';
    end if;
    v_seen_stock_ids := array_append(v_seen_stock_ids, v_stock_id);

    select stock.*
    into v_stock
    from public.stock_items as stock
    where stock.id = v_stock_id;

    if not found
       or not v_stock.is_active
       or v_stock.archived_at is not null then
      raise exception 'stock_item_unavailable:%', v_stock_id using errcode = 'P0001';
    end if;

    select coalesce(sum(items.quantity), 0)::integer
    into v_held
    from public.reservation_items as items
    join public.reservations as reservation
      on reservation.id = items.reservation_id
    where items.stock_item_id = v_stock_id
      and reservation.status in ('reserved', 'paid', 'delivered')
      and (
        p_exclude_reservation_id is null
        or reservation.id <> p_exclude_reservation_id
      );

    v_available := greatest(v_stock.quantity - v_held, 0);

    if v_quantity > v_available then
      raise exception 'insufficient_stock:%:%', v_stock_id, v_available
        using errcode = 'P0001';
    end if;

    if v_item_id is not null then
      if p_exclude_reservation_id is null then
        raise exception 'invalid_reservation_item_reference' using errcode = 'P0001';
      end if;

      select items.*
      into v_existing
      from public.reservation_items as items
      where items.id = v_item_id
        and items.reservation_id = p_exclude_reservation_id
        and items.stock_item_id = v_stock_id;

      if not found then
        raise exception 'invalid_reservation_item_reference' using errcode = 'P0001';
      end if;

      v_item_name := v_existing.item_name;
      v_sku := v_existing.sku;
      v_category := v_existing.category;
      v_image_path := v_existing.image_path;
    else
      v_item_id := gen_random_uuid();
      v_item_name := v_stock.name;
      v_sku := v_stock.sku;
      v_category := v_stock.category;
      v_image_path := v_stock.image_path;
    end if;

    v_line_total := (v_unit_price * v_quantity) - v_discount;

    if v_discount > v_unit_price * v_quantity or v_line_total < 0 then
      raise exception 'line_discount_exceeds_subtotal:%', v_stock_id
        using errcode = 'P0001';
    end if;

    if v_line_total > 9999999999.99 then
      raise exception 'reservation_total_too_large' using errcode = 'P0001';
    end if;

    v_subtotal := v_subtotal + v_line_total;
    v_prepared_items := v_prepared_items || jsonb_build_array(
      jsonb_build_object(
        'id', v_item_id,
        'stock_item_id', v_stock_id,
        'item_name', v_item_name,
        'sku', v_sku,
        'category', v_category,
        'quantity', v_quantity,
        'unit_price', v_unit_price,
        'discount', v_discount,
        'line_total', v_line_total,
        'image_path', v_image_path
      )
    );
  end loop;

  if v_subtotal > 9999999999.99 then
    raise exception 'reservation_total_too_large' using errcode = 'P0001';
  end if;

  return jsonb_build_object('items', v_prepared_items, 'subtotal', v_subtotal);
end;
$function$;

revoke all on function public.prepare_reservation_items(jsonb, uuid)
  from public, anon, authenticated;

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
    (v_reservation.status = 'paid' and p_new_status = 'delivered')
    or (
      v_role = 'admin'
      and v_reservation.status = 'reserved'
      and p_new_status = 'cancelled'
    );

  if not v_allowed then
    raise exception 'invalid_status_transition:%:%',
      v_reservation.status,
      p_new_status
      using errcode = 'P0001';
  end if;

  update public.reservations
  set
    status = p_new_status,
    delivered_at = case when p_new_status = 'delivered' then v_now else delivered_at end,
    cancelled_at = case when p_new_status = 'cancelled' then v_now else cancelled_at end
  where id = p_reservation_id;

  insert into public.reservation_status_history (
    reservation_id,
    old_status,
    new_status,
    changed_by,
    changed_at
  )
  values (
    p_reservation_id,
    v_reservation.status,
    p_new_status,
    v_user_id,
    v_now
  );

  return p_reservation_id;
end;
$function$;

revoke all on function public.transition_reservation_status(uuid, text, timestamptz)
  from public, anon;
grant execute on function public.transition_reservation_status(uuid, text, timestamptz)
  to authenticated;

create or replace function public.record_reservation_payment_and_mark_paid(
  p_reservation_id uuid,
  p_expected_updated_at timestamptz,
  p_amount numeric,
  p_payment_method text,
  p_reference_no text,
  p_evidence_path text,
  p_notes text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_reservation public.reservations%rowtype;
  v_payment_id uuid;
  v_total_paid numeric(12, 2);
  v_existing_payment_count integer;
  v_legacy_paid numeric(12, 2);
  v_now timestamptz := timezone('utc', now());
begin
  if v_user_id is null
     or public.current_profile_role() not in ('admin', 'staff') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  select reservation.*
  into v_reservation
  from public.reservations as reservation
  where reservation.id = p_reservation_id
  for update;

  if not found then
    raise exception 'reservation_not_found' using errcode = 'P0001';
  end if;
  if v_reservation.archived_at is not null
     or v_reservation.status <> 'reserved' then
    raise exception 'reservation_not_payable' using errcode = 'P0001';
  end if;
  if v_reservation.updated_at is distinct from p_expected_updated_at then
    raise exception 'stale_reservation' using errcode = 'P0001';
  end if;
  if not v_reservation.pricing_complete
     or exists (
       select 1
       from public.reservation_items
       where reservation_id = p_reservation_id
         and not price_confirmed
     ) then
    raise exception 'pricing_incomplete' using errcode = 'P0001';
  end if;
  if v_reservation.total <= 0 then
    raise exception 'invalid_reservation_total' using errcode = 'P0001';
  end if;

  if p_amount is null
     or p_amount = 'NaN'::numeric
     or p_amount <= 0
     or p_amount > 9999999999.99
     or p_amount <> round(p_amount, 2)
     or char_length(coalesce(p_payment_method, '')) > 120
     or char_length(coalesce(p_reference_no, '')) > 200
     or char_length(coalesce(p_evidence_path, '')) > 1024
     or char_length(coalesce(p_notes, '')) > 2000 then
    raise exception 'invalid_payment' using errcode = 'P0001';
  end if;

  if nullif(btrim(p_evidence_path), '') is not null and not exists (
    select 1
    from storage.objects as object
    where object.bucket_id = 'payment-evidence'
      and object.name = p_evidence_path
      and (storage.foldername(object.name))[1] = v_user_id::text
  ) then
    raise exception 'invalid_payment_evidence' using errcode = 'P0001';
  end if;

  select count(*)::integer
  into v_existing_payment_count
  from public.reservation_payments
  where reservation_id = p_reservation_id;
  v_legacy_paid := case
    when v_existing_payment_count = 0 then v_reservation.downpayment
    else 0
  end;

  insert into public.reservation_payments (
    reservation_id,
    amount,
    payment_method,
    reference_no,
    evidence_path,
    notes,
    recorded_by,
    recorded_at
  )
  values (
    p_reservation_id,
    p_amount,
    nullif(btrim(p_payment_method), ''),
    nullif(btrim(p_reference_no), ''),
    nullif(btrim(p_evidence_path), ''),
    nullif(btrim(p_notes), ''),
    v_user_id,
    v_now
  )
  returning id into v_payment_id;

  select coalesce(sum(payment.amount), 0) + v_legacy_paid
  into v_total_paid
  from public.reservation_payments as payment
  where payment.reservation_id = p_reservation_id
    and payment.voided_at is null;

  if v_total_paid < v_reservation.total then
    raise exception 'underpaid_reservation:%:%',
      v_total_paid,
      v_reservation.total
      using errcode = 'P0001';
  end if;

  update public.reservations
  set
    status = 'paid',
    downpayment = least(total, v_total_paid),
    balance = greatest(total - v_total_paid, 0),
    paid_at = v_now
  where id = p_reservation_id;

  insert into public.reservation_status_history (
    reservation_id,
    old_status,
    new_status,
    changed_by,
    changed_at
  )
  values (p_reservation_id, 'reserved', 'paid', v_user_id, v_now);

  return v_payment_id;
end;
$function$;

revoke all on function public.record_reservation_payment_and_mark_paid(
  uuid, timestamptz, numeric, text, text, text, text
) from public, anon;
grant execute on function public.record_reservation_payment_and_mark_paid(
  uuid, timestamptz, numeric, text, text, text, text
) to authenticated;

create or replace function public.bulk_mark_reservations_paid(p_payments jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_input jsonb;
  v_ids uuid[] := array[]::uuid[];
  v_reservation_id uuid;
  v_payment_id uuid;
  v_count integer := 0;
begin
  if auth.uid() is null
     or public.current_profile_role() not in ('admin', 'staff') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if jsonb_typeof(p_payments) <> 'array'
     or jsonb_array_length(p_payments) < 1
     or jsonb_array_length(p_payments) > 50 then
    raise exception 'invalid_bulk_payment' using errcode = 'P0001';
  end if;

  for v_input in
    select payment.value
    from jsonb_array_elements(p_payments) with ordinality as payment(value, position)
    order by payment.position
  loop
    begin
      v_reservation_id := (v_input ->> 'reservation_id')::uuid;
    exception
      when invalid_text_representation then
        raise exception 'invalid_bulk_payment' using errcode = 'P0001';
    end;

    if v_reservation_id = any(v_ids) then
      raise exception 'duplicate_reservation' using errcode = 'P0001';
    end if;
    v_ids := array_append(v_ids, v_reservation_id);

    v_payment_id := public.record_reservation_payment_and_mark_paid(
      v_reservation_id,
      (v_input ->> 'expected_updated_at')::timestamptz,
      (v_input ->> 'amount')::numeric,
      v_input ->> 'payment_method',
      v_input ->> 'reference_no',
      v_input ->> 'evidence_path',
      v_input ->> 'notes'
    );
    v_count := v_count + 1;
  end loop;

  return jsonb_build_object('reservationCount', v_count);
exception
  when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'invalid_bulk_payment' using errcode = 'P0001';
end;
$function$;

revoke all on function public.bulk_mark_reservations_paid(jsonb)
  from public, anon;
grant execute on function public.bulk_mark_reservations_paid(jsonb)
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

  if (
    select count(*)
    from public.reservations
    where id = any(p_reservation_ids)
      and archived_at is null
      and status = case
        when p_new_status = 'cancelled' then 'reserved'
        else 'paid'
      end
  ) <> array_length(p_reservation_ids, 1) then
    raise exception 'invalid_bulk_transition' using errcode = 'P0001';
  end if;

  foreach v_id in array p_reservation_ids loop
    update public.reservations
    set
      status = p_new_status,
      cancelled_at = case when p_new_status = 'cancelled' then v_now else cancelled_at end,
      delivered_at = case when p_new_status = 'delivered' then v_now else delivered_at end
    where id = v_id;

    insert into public.reservation_status_history (
      reservation_id,
      old_status,
      new_status,
      changed_by,
      changed_at
    )
    values (
      v_id,
      case when p_new_status = 'cancelled' then 'reserved' else 'paid' end,
      p_new_status,
      v_user_id,
      v_now
    );
  end loop;

  return array_length(p_reservation_ids, 1);
end;
$function$;

revoke all on function public.bulk_transition_reservations(uuid[], text)
  from public, anon;
grant execute on function public.bulk_transition_reservations(uuid[], text)
  to authenticated;

create or replace function public.bulk_revert_paid_reservations(
  p_reservation_ids uuid[],
  p_reason text
)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_id uuid;
  v_now timestamptz := timezone('utc', now());
  v_reason text := nullif(btrim(p_reason), '');
begin
  if v_user_id is null or public.current_profile_role() <> 'admin' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_reason is null or char_length(v_reason) > 1000 then
    raise exception 'revert_reason_required' using errcode = 'P0001';
  end if;
  if coalesce(array_length(p_reservation_ids, 1), 0) < 1
     or array_length(p_reservation_ids, 1) > 50
     or (
       select count(distinct value)
       from unnest(p_reservation_ids) as selected(value)
     ) <> array_length(p_reservation_ids, 1) then
    raise exception 'invalid_bulk_selection' using errcode = 'P0001';
  end if;

  perform reservation.id
  from public.reservations as reservation
  where reservation.id = any(p_reservation_ids)
  order by reservation.id
  for update;

  if (
    select count(*)
    from public.reservations
    where id = any(p_reservation_ids)
      and archived_at is null
      and status = 'paid'
  ) <> array_length(p_reservation_ids, 1) then
    raise exception 'invalid_bulk_revert' using errcode = 'P0001';
  end if;

  update public.reservation_payments
  set
    voided_at = v_now,
    voided_by = v_user_id,
    void_reason = v_reason
  where reservation_id = any(p_reservation_ids)
    and voided_at is null;

  foreach v_id in array p_reservation_ids loop
    update public.reservations
    set
      status = 'reserved',
      downpayment = 0,
      balance = total,
      paid_at = null
    where id = v_id;

    insert into public.reservation_status_history (
      reservation_id,
      old_status,
      new_status,
      changed_by,
      changed_at,
      reason
    )
    values (v_id, 'paid', 'reserved', v_user_id, v_now, v_reason);
  end loop;

  return array_length(p_reservation_ids, 1);
end;
$function$;

revoke all on function public.bulk_revert_paid_reservations(uuid[], text)
  from public, anon;
grant execute on function public.bulk_revert_paid_reservations(uuid[], text)
  to authenticated;

create or replace function public.confirm_live_order_import(
  p_original_file_name text,
  p_file_hash text,
  p_default_live_batch text,
  p_rows jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_batch_id uuid;
  v_group record;
  v_input jsonb;
  v_customer_id uuid;
  v_customer_matches integer;
  v_customer_name text;
  v_facebook_name text;
  v_reservation_id uuid;
  v_reservation_count integer := 0;
  v_item_count integer := 0;
  v_new_customer_count integer := 0;
  v_stock public.stock_items%rowtype;
  v_stock_matches integer;
  v_stock_id uuid;
  v_seen_stock_ids uuid[];
  v_held integer;
  v_available integer;
  v_batch_labels text[];
begin
  if v_user_id is null
     or public.current_profile_role() not in ('admin', 'staff') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_original_file_name, ''))) not between 1 and 255
     or coalesce(p_file_hash, '') !~ '^[0-9a-f]{64}$'
     or char_length(coalesce(p_default_live_batch, '')) > 120
     or jsonb_typeof(p_rows) <> 'array'
     or jsonb_array_length(p_rows) < 1
     or jsonb_array_length(p_rows) > 2000 then
    raise exception 'invalid_import_file' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from public.reservation_import_batches where file_hash = p_file_hash
  ) then
    raise exception 'duplicate_import' using errcode = 'P0001';
  end if;

  perform stock.id
  from public.stock_items as stock
  where upper(btrim(stock.sku)) in (
    select distinct upper(btrim(row.value ->> 'itemCode'))
    from jsonb_array_elements(p_rows) as row(value)
  )
  order by stock.id
  for update;

  select array_agg(distinct batch_label order by batch_label)
  into v_batch_labels
  from (
    select nullif(
      btrim(coalesce(nullif(row.value ->> 'liveBatch', ''), p_default_live_batch)),
      ''
    ) as batch_label
    from jsonb_array_elements(p_rows) as row(value)
  ) as labels
  where batch_label is not null;

  insert into public.reservation_import_batches (
    original_file_name,
    file_hash,
    live_batch,
    imported_by,
    row_count,
    reservation_count,
    item_count,
    new_customer_count,
    total_value
  )
  values (
    left(btrim(p_original_file_name), 255),
    p_file_hash,
    case
      when coalesce(array_length(v_batch_labels, 1), 0) = 1 then v_batch_labels[1]
      when coalesce(array_length(v_batch_labels, 1), 0) > 1 then 'Multiple'
      else null
    end,
    v_user_id,
    jsonb_array_length(p_rows),
    0,
    0,
    0,
    0
  )
  returning id into v_batch_id;

  for v_group in
    select
      public.normalize_live_identity(row.value ->> 'facebookName') as identity_key,
      nullif(
        btrim(coalesce(nullif(row.value ->> 'liveBatch', ''), p_default_live_batch)),
        ''
      ) as live_batch
    from jsonb_array_elements(p_rows) with ordinality as row(value, position)
    group by
      public.normalize_live_identity(row.value ->> 'facebookName'),
      nullif(
        btrim(coalesce(nullif(row.value ->> 'liveBatch', ''), p_default_live_batch)),
        ''
      )
    order by min(row.position)
  loop
    if char_length(v_group.identity_key) < 1 then
      raise exception 'invalid_customer_identity' using errcode = 'P0001';
    end if;

    select
      count(*)::integer,
      (array_agg(customer.id order by customer.id))[1]
    into v_customer_matches, v_customer_id
    from public.customers as customer
    where customer.archived_at is null
      and public.normalize_live_identity(customer.facebook_name) = v_group.identity_key;

    if v_customer_matches > 1 then
      raise exception 'customer_ambiguous:%', v_group.identity_key
        using errcode = 'P0001';
    end if;

    select
      left(
        coalesce(
          nullif(btrim(row.value ->> 'customerName'), ''),
          nullif(btrim(row.value ->> 'facebookName'), '')
        ),
        160
      ),
      nullif(btrim(row.value ->> 'facebookName'), '')
    into v_customer_name, v_facebook_name
    from jsonb_array_elements(p_rows) with ordinality as row(value, position)
    where public.normalize_live_identity(row.value ->> 'facebookName') = v_group.identity_key
      and nullif(
        btrim(coalesce(nullif(row.value ->> 'liveBatch', ''), p_default_live_batch)),
        ''
      ) is not distinct from v_group.live_batch
    order by row.position
    limit 1;

    if char_length(coalesce(v_customer_name, '')) < 2
       or v_facebook_name is null
       or char_length(v_facebook_name) > 160 then
      raise exception 'invalid_customer_identity' using errcode = 'P0001';
    end if;

    if v_customer_matches = 0 then
      insert into public.customers (
        name,
        facebook_name,
        email,
        phone,
        address,
        notes,
        created_by
      )
      values (
        v_customer_name,
        left(v_facebook_name, 160),
        null,
        null,
        null,
        'Created by Live Selling import.',
        v_user_id
      )
      returning id into v_customer_id;
      v_new_customer_count := v_new_customer_count + 1;
    end if;

    insert into public.reservations (
      customer_id,
      status,
      subtotal,
      discount,
      downpayment,
      total,
      balance,
      notes,
      created_by,
      live_batch,
      import_batch_id,
      pricing_complete
    )
    values (
      v_customer_id,
      'reserved',
      0,
      0,
      0,
      0,
      0,
      null,
      v_user_id,
      v_group.live_batch,
      v_batch_id,
      false
    )
    returning id into v_reservation_id;

    v_seen_stock_ids := array[]::uuid[];

    for v_input in
      select row.value
      from jsonb_array_elements(p_rows) with ordinality as row(value, position)
      where public.normalize_live_identity(row.value ->> 'facebookName') = v_group.identity_key
        and nullif(
          btrim(coalesce(nullif(row.value ->> 'liveBatch', ''), p_default_live_batch)),
          ''
        ) is not distinct from v_group.live_batch
      order by row.position
    loop
      if nullif(btrim(v_input ->> 'itemCode'), '') is null then
        raise exception 'invalid_import_row' using errcode = 'P0001';
      end if;

      select
        count(*)::integer,
        (array_agg(stock.id order by stock.id))[1]
      into v_stock_matches, v_stock_id
      from public.stock_items as stock
      where stock.archived_at is null
        and stock.is_active
        and upper(btrim(stock.sku)) = upper(btrim(v_input ->> 'itemCode'));

      if v_stock_matches = 0 then
        raise exception 'item_not_found:%', left(v_input ->> 'itemCode', 64)
          using errcode = 'P0001';
      elsif v_stock_matches > 1 then
        raise exception 'item_ambiguous:%', left(v_input ->> 'itemCode', 64)
          using errcode = 'P0001';
      end if;

      if v_stock_id = any(v_seen_stock_ids) then
        raise exception 'duplicate_stock_item:%', v_stock_id using errcode = 'P0001';
      end if;
      v_seen_stock_ids := array_append(v_seen_stock_ids, v_stock_id);

      select stock.*
      into v_stock
      from public.stock_items as stock
      where stock.id = v_stock_id;

      select coalesce(sum(items.quantity), 0)::integer
      into v_held
      from public.reservation_items as items
      join public.reservations as reservation
        on reservation.id = items.reservation_id
      where items.stock_item_id = v_stock_id
        and reservation.status in ('reserved', 'paid', 'delivered');

      v_available := greatest(v_stock.quantity - v_held, 0);
      if v_available < 1 then
        raise exception 'insufficient_stock:%:%', v_stock_id, v_available
          using errcode = 'P0001';
      end if;

      insert into public.reservation_items (
        reservation_id,
        stock_item_id,
        item_name,
        sku,
        category,
        quantity,
        unit_price,
        discount,
        line_total,
        image_path,
        price_confirmed
      )
      values (
        v_reservation_id,
        v_stock.id,
        v_stock.name,
        v_stock.sku,
        v_stock.category,
        1,
        0,
        0,
        0,
        v_stock.image_path,
        false
      );

      v_item_count := v_item_count + 1;
    end loop;

    update public.reservations
    set
      subtotal = 0,
      discount = 0,
      downpayment = 0,
      total = 0,
      balance = 0,
      pricing_complete = false
    where id = v_reservation_id;

    insert into public.reservation_status_history (
      reservation_id,
      old_status,
      new_status,
      changed_by
    )
    values (v_reservation_id, null, 'reserved', v_user_id);

    v_reservation_count := v_reservation_count + 1;
  end loop;

  update public.reservation_import_batches
  set
    reservation_count = v_reservation_count,
    item_count = v_item_count,
    new_customer_count = v_new_customer_count,
    total_value = 0
  where id = v_batch_id;

  return jsonb_build_object(
    'batchId', v_batch_id,
    'reservationCount', v_reservation_count,
    'itemCount', v_item_count,
    'newCustomerCount', v_new_customer_count,
    'totalValue', 0
  );
exception
  when unique_violation then
    if exists (
      select 1
      from public.reservation_import_batches
      where file_hash = p_file_hash
    ) then
      raise exception 'duplicate_import' using errcode = 'P0001';
    end if;
    raise;
end;
$function$;

revoke all on function public.confirm_live_order_import(text, text, text, jsonb)
  from public, anon;
grant execute on function public.confirm_live_order_import(text, text, text, jsonb)
  to authenticated;

create or replace function public.get_payment_metrics()
returns table (
  paid_amount numeric,
  payments_awaiting_evidence bigint
)
language sql
stable
security invoker
set search_path = ''
as $function$
  select
    coalesce(sum(payment.amount) filter (
      where payment.voided_at is null
    ), 0)::numeric as paid_amount,
    count(*) filter (
      where payment.voided_at is null
        and payment.evidence_path is null
    )::bigint as payments_awaiting_evidence
  from public.reservation_payments as payment;
$function$;

revoke all on function public.get_payment_metrics() from public, anon;
grant execute on function public.get_payment_metrics() to authenticated;

drop function public.get_reservation_status_history(uuid);

create function public.get_reservation_status_history(
  p_reservation_id uuid
)
returns table (
  id uuid,
  old_status text,
  new_status text,
  changed_by uuid,
  changed_by_name text,
  changed_at timestamptz,
  reason text
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if auth.uid() is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  return query
  select
    history.id,
    history.old_status,
    history.new_status,
    history.changed_by,
    profile.full_name,
    history.changed_at,
    history.reason
  from public.reservation_status_history as history
  left join public.profiles as profile
    on profile.id = history.changed_by
  where history.reservation_id = p_reservation_id
  order by history.changed_at, history.id;
end;
$function$;

revoke all on function public.get_reservation_status_history(uuid)
  from public, anon;
grant execute on function public.get_reservation_status_history(uuid)
  to authenticated;

create or replace view public.reservation_list
with (security_invoker = true)
as
select
  reservation.id,
  reservation.reservation_no,
  reservation.customer_id,
  customer.name as customer_name,
  customer.email as customer_email,
  customer.phone as customer_phone,
  count(items.id)::bigint as item_count,
  reservation.total,
  reservation.downpayment,
  reservation.balance,
  reservation.status,
  reservation.reserved_at,
  reservation.archived_at,
  reservation.updated_at,
  customer.facebook_name as customer_facebook_name,
  reservation.live_batch,
  reservation.import_batch_id,
  reservation.pricing_complete
from public.reservations as reservation
join public.customers as customer
  on customer.id = reservation.customer_id
left join public.reservation_items as items
  on items.reservation_id = reservation.id
group by
  reservation.id,
  reservation.reservation_no,
  reservation.customer_id,
  customer.name,
  customer.email,
  customer.phone,
  reservation.total,
  reservation.downpayment,
  reservation.balance,
  reservation.status,
  reservation.reserved_at,
  reservation.archived_at,
  reservation.updated_at,
  customer.facebook_name,
  reservation.live_batch,
  reservation.import_batch_id,
  reservation.pricing_complete;

revoke all on table public.reservation_list from anon, authenticated;
grant select on table public.reservation_list to authenticated;

comment on column public.reservations.pricing_complete is
  'False until every imported reservation item has a seller-confirmed price.';
comment on column public.reservation_items.price_confirmed is
  'Distinguishes an intentionally entered zero price from an import placeholder.';
comment on table public.reservation_payments is
  'Append-only reservation payment audit records; reversals void rather than delete.';

commit;
