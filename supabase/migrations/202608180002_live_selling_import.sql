begin;

alter table public.reservations
  add column live_batch text,
  add column import_batch_id uuid;

create table public.reservation_import_batches (
  id uuid primary key default gen_random_uuid(),
  original_file_name text not null,
  file_hash text not null unique,
  live_batch text,
  imported_by uuid references auth.users (id) on delete set null,
  confirmed_at timestamptz not null default timezone('utc', now()),
  row_count integer not null,
  reservation_count integer not null,
  item_count integer not null,
  new_customer_count integer not null default 0,
  total_value numeric(12, 2) not null,
  constraint reservation_import_batches_file_name_length
    check (char_length(btrim(original_file_name)) between 1 and 255),
  constraint reservation_import_batches_hash_format
    check (file_hash ~ '^[0-9a-f]{64}$'),
  constraint reservation_import_batches_live_batch_length
    check (live_batch is null or char_length(live_batch) <= 120),
  constraint reservation_import_batches_counts_nonnegative
    check (
      row_count > 0
      and reservation_count >= 0
      and item_count >= 0
      and new_customer_count >= 0
    ),
  constraint reservation_import_batches_total_nonnegative
    check (total_value >= 0)
);

alter table public.reservations
  add constraint reservations_live_batch_length
    check (live_batch is null or char_length(live_batch) <= 120),
  add constraint reservations_import_batch_id_fkey
    foreign key (import_batch_id)
    references public.reservation_import_batches (id)
    on delete restrict;

create index reservations_live_batch_idx
  on public.reservations (live_batch)
  where live_batch is not null;
create index reservations_import_batch_id_idx
  on public.reservations (import_batch_id)
  where import_batch_id is not null;
create index reservation_import_batches_confirmed_at_idx
  on public.reservation_import_batches (confirmed_at desc);
create index reservation_import_batches_imported_by_idx
  on public.reservation_import_batches (imported_by);

revoke all on table public.reservation_import_batches from anon, authenticated;
grant select on table public.reservation_import_batches to authenticated;

alter table public.reservation_import_batches enable row level security;

create policy "reservation_import_batches_select_admin_staff"
on public.reservation_import_batches
for select
to authenticated
using ((select public.current_profile_role()) in ('admin', 'staff'));

create or replace function public.normalize_live_identity(p_value text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $function$
  select regexp_replace(lower(btrim(coalesce(p_value, ''))), '[[:space:]]+', ' ', 'g');
$function$;

revoke all on function public.normalize_live_identity(text)
  from public, anon, authenticated;

create index customers_facebook_name_normalized_active_idx
  on public.customers (public.normalize_live_identity(facebook_name))
  where archived_at is null and facebook_name is not null;
create index stock_items_sku_normalized_active_idx
  on public.stock_items (upper(btrim(sku)))
  where archived_at is null and is_active;

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
  v_total_value numeric(12, 2) := 0;
  v_subtotal numeric(12, 2);
  v_notes text;
  v_stock public.stock_items%rowtype;
  v_stock_matches integer;
  v_stock_id uuid;
  v_seen_stock_ids uuid[];
  v_quantity integer;
  v_unit_price numeric(12, 2);
  v_discount numeric(12, 2);
  v_line_total numeric(12, 2);
  v_held integer;
  v_available integer;
  v_effective_live_batch text;
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
    select 1
    from public.reservation_import_batches
    where file_hash = p_file_hash
  ) then
    raise exception 'duplicate_import' using errcode = 'P0001';
  end if;

  -- Lock every matched stock row in a deterministic order. This serializes the
  -- final availability check with manual reservation creation and other imports.
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

    select left(
      string_agg(note_value, E'\n' order by position),
      4000
    )
    into v_notes
    from (
      select
        row.position,
        nullif(btrim(row.value ->> 'notes'), '') as note_value
      from jsonb_array_elements(p_rows) with ordinality as row(value, position)
      where public.normalize_live_identity(row.value ->> 'facebookName') = v_group.identity_key
        and nullif(
          btrim(coalesce(nullif(row.value ->> 'liveBatch', ''), p_default_live_batch)),
          ''
        ) is not distinct from v_group.live_batch
    ) as group_notes
    where note_value is not null;

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
      import_batch_id
    )
    values (
      v_customer_id,
      'reserved',
      0,
      0,
      0,
      0,
      0,
      v_notes,
      v_user_id,
      v_group.live_batch,
      v_batch_id
    )
    returning id into v_reservation_id;

    v_subtotal := 0;
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
      if nullif(btrim(v_input ->> 'itemCode'), '') is null
         or coalesce(v_input ->> 'quantity', '1') !~ '^[0-9]+$'
         or coalesce(nullif(v_input ->> 'price', ''), '0') !~ '^[0-9]{1,10}([.][0-9]{1,2})?$'
         or coalesce(nullif(v_input ->> 'discount', ''), '0') !~ '^[0-9]{1,10}([.][0-9]{1,2})?$' then
        raise exception 'invalid_import_row' using errcode = 'P0001';
      end if;

      begin
        v_quantity := coalesce(nullif(v_input ->> 'quantity', ''), '1')::integer;
        v_discount := coalesce(nullif(v_input ->> 'discount', ''), '0')::numeric;
      exception
        when invalid_text_representation or numeric_value_out_of_range then
          raise exception 'invalid_import_row' using errcode = 'P0001';
      end;

      if v_quantity <= 0 or v_discount < 0 or v_discount <> round(v_discount, 2) then
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

      if v_quantity > v_available then
        raise exception 'insufficient_stock:%:%', v_stock_id, v_available
          using errcode = 'P0001';
      end if;

      if nullif(v_input ->> 'price', '') is null then
        v_unit_price := v_stock.price;
      else
        v_unit_price := (v_input ->> 'price')::numeric;
      end if;

      if v_unit_price < 0
         or v_unit_price > 9999999999.99
         or v_unit_price <> round(v_unit_price, 2) then
        raise exception 'invalid_import_price' using errcode = 'P0001';
      end if;

      v_line_total := (v_unit_price * v_quantity) - v_discount;

      if v_discount > v_unit_price * v_quantity
         or v_line_total < 0
         or v_line_total > 9999999999.99 then
        raise exception 'invalid_import_discount' using errcode = 'P0001';
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
        image_path
      )
      values (
        v_reservation_id,
        v_stock.id,
        v_stock.name,
        v_stock.sku,
        v_stock.category,
        v_quantity,
        v_unit_price,
        v_discount,
        v_line_total,
        v_stock.image_path
      );

      v_subtotal := v_subtotal + v_line_total;
      v_item_count := v_item_count + 1;
    end loop;

    if v_subtotal > 9999999999.99 then
      raise exception 'reservation_total_too_large' using errcode = 'P0001';
    end if;

    update public.reservations
    set
      subtotal = v_subtotal,
      total = v_subtotal,
      balance = v_subtotal
    where id = v_reservation_id;

    insert into public.reservation_status_history (
      reservation_id,
      old_status,
      new_status,
      changed_by
    )
    values (v_reservation_id, null, 'reserved', v_user_id);

    v_reservation_count := v_reservation_count + 1;
    v_total_value := v_total_value + v_subtotal;
  end loop;

  update public.reservation_import_batches
  set
    reservation_count = v_reservation_count,
    item_count = v_item_count,
    new_customer_count = v_new_customer_count,
    total_value = v_total_value
  where id = v_batch_id;

  return jsonb_build_object(
    'batchId', v_batch_id,
    'reservationCount', v_reservation_count,
    'itemCount', v_item_count,
    'newCustomerCount', v_new_customer_count,
    'totalValue', v_total_value
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

create or replace function public.get_live_import_metrics()
returns table (
  imported_reservations_today bigint,
  imported_items_today bigint,
  imported_reserved_value numeric,
  new_customers_from_imports bigint
)
language sql
stable
security invoker
set search_path = ''
as $function$
  select
    coalesce(sum(batch.reservation_count) filter (
      where batch.confirmed_at >= date_trunc(
        'day',
        timezone('Asia/Manila', now())
      ) at time zone 'Asia/Manila'
    ), 0)::bigint,
    coalesce(sum(batch.item_count) filter (
      where batch.confirmed_at >= date_trunc(
        'day',
        timezone('Asia/Manila', now())
      ) at time zone 'Asia/Manila'
    ), 0)::bigint,
    coalesce(sum(batch.total_value) filter (
      where batch.confirmed_at >= date_trunc(
        'day',
        timezone('Asia/Manila', now())
      ) at time zone 'Asia/Manila'
    ), 0)::numeric,
    coalesce(sum(batch.new_customer_count), 0)::bigint
  from public.reservation_import_batches as batch;
$function$;

revoke all on function public.get_live_import_metrics() from public, anon;
grant execute on function public.get_live_import_metrics() to authenticated;

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
  reservation.import_batch_id
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
  reservation.import_batch_id;

revoke all on table public.reservation_list from anon, authenticated;
grant select on table public.reservation_list to authenticated;

comment on table public.reservation_import_batches is
  'Successful atomic Live Selling imports, keyed by SHA-256 file content.';
comment on column public.reservations.live_batch is
  'Optional Facebook Live Selling batch label used for grouping and filtering.';
comment on column public.reservations.import_batch_id is
  'The confirmed Live Selling import batch that created this reservation.';

commit;
