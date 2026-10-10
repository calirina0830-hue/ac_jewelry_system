begin;

create or replace function public.get_reservable_stock(
  p_exclude_reservation_id uuid default null
)
returns table (
  id uuid,
  sku text,
  name text,
  price numeric,
  quantity integer,
  available_quantity integer,
  image_path text
)
language sql
stable
security invoker
set search_path = ''
as $function$
  select
    stock.id,
    stock.sku,
    stock.name,
    stock.price,
    stock.quantity,
    2147483647::integer as available_quantity,
    stock.image_path
  from public.stock_items as stock
  where stock.is_active
    and stock.archived_at is null
  order by stock.name, stock.sku;
$function$;

revoke all on function public.get_reservable_stock(uuid) from public, anon;
grant execute on function public.get_reservable_stock(uuid) to authenticated;

comment on function public.get_reservable_stock(uuid) is
  'Returns active catalog items. Legacy stock quantity and reservation holds do not limit selection.';

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
       or v_quantity < 1
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
  v_quantity integer;
  v_seen_stock_ids uuid[];
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
    original_file_name, file_hash, live_batch, imported_by, row_count,
    reservation_count, item_count, new_customer_count, total_value
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
    0, 0, 0, 0
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

    select count(*)::integer, (array_agg(customer.id order by customer.id))[1]
    into v_customer_matches, v_customer_id
    from public.customers as customer
    where customer.archived_at is null
      and public.normalize_live_identity(customer.facebook_name) = v_group.identity_key;

    if v_customer_matches > 1 then
      raise exception 'customer_ambiguous:%', v_group.identity_key
        using errcode = 'P0001';
    end if;

    select
      left(coalesce(
        nullif(btrim(row.value ->> 'customerName'), ''),
        nullif(btrim(row.value ->> 'facebookName'), '')
      ), 160),
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
        name, facebook_name, email, phone, address, notes, created_by
      )
      values (
        v_customer_name, left(v_facebook_name, 160), null, null, null,
        'Created by Live Selling import.', v_user_id
      )
      returning id into v_customer_id;
      v_new_customer_count := v_new_customer_count + 1;
    end if;

    insert into public.reservations (
      customer_id, status, subtotal, discount, downpayment, total, balance,
      notes, created_by, live_batch, import_batch_id, pricing_complete
    )
    values (
      v_customer_id, 'reserved', 0, 0, 0, 0, 0, null, v_user_id,
      v_group.live_batch, v_batch_id, false
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

      begin
        v_quantity := coalesce(nullif(btrim(v_input ->> 'quantity'), '')::integer, 1);
      exception
        when invalid_text_representation or numeric_value_out_of_range then
          raise exception 'invalid_quantity' using errcode = 'P0001';
      end;
      if v_quantity < 1 then
        raise exception 'invalid_quantity' using errcode = 'P0001';
      end if;

      select count(*)::integer, (array_agg(stock.id order by stock.id))[1]
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

      select stock.* into v_stock
      from public.stock_items as stock
      where stock.id = v_stock_id;

      insert into public.reservation_items (
        reservation_id, stock_item_id, item_name, sku, category, quantity,
        unit_price, discount, line_total, image_path, price_confirmed
      )
      values (
        v_reservation_id, v_stock.id, v_stock.name, v_stock.sku, v_stock.category,
        v_quantity, 0, 0, 0, v_stock.image_path, false
      );

      v_item_count := v_item_count + 1;
    end loop;

    update public.reservations
    set subtotal = 0, discount = 0, downpayment = 0, total = 0,
        balance = 0, pricing_complete = false
    where id = v_reservation_id;

    insert into public.reservation_status_history (
      reservation_id, old_status, new_status, changed_by
    )
    values (v_reservation_id, null, 'reserved', v_user_id);

    v_reservation_count := v_reservation_count + 1;
  end loop;

  update public.reservation_import_batches
  set reservation_count = v_reservation_count,
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
      select 1 from public.reservation_import_batches where file_hash = p_file_hash
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

comment on column public.stock_items.quantity is
  'Legacy compatibility field. Catalog selection and reservation quantities do not depend on it.';
comment on column public.reservation_items.quantity is
  'Seller-entered customer order quantity used for trusted reservation and invoice totals.';

commit;
