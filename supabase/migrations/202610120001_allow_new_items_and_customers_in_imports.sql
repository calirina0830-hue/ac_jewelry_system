-- ============================================================================
-- Migration: 202610120001_allow_new_items_and_customers_in_imports.sql
-- Description:
--   1. Grant execute on public.normalize_live_identity() so customers can be
--      inserted/updated without triggering "permission denied" on index maintenance.
--   2. Update confirm_live_order_import() to automatically create new items in
--      stock_items when an imported Item Code does not yet exist in the catalog,
--      preventing "item_not_found" rejections.
-- ============================================================================

begin;

-- 1. Grant execute permissions on normalize_live_identity
grant execute on function public.normalize_live_identity(text) to authenticated, anon;

-- 2. Update confirm_live_order_import to auto-create new stock items
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
  v_customer_matches integer;
  v_customer_id uuid;
  v_customer_name text;
  v_facebook_name text;
  v_reservation_id uuid;
  v_subtotal numeric(12, 2) := 0;
  v_reservation_count integer := 0;
  v_item_count integer := 0;
  v_new_customer_count integer := 0;
  v_total_value numeric(12, 2) := 0;
  v_stock public.stock_items%rowtype;
  v_stock_matches integer;
  v_stock_id uuid;
  v_quantity integer;
  v_unit_price numeric(12, 2);
  v_line_total numeric(12, 2);
  v_group_downpayment numeric(12, 2);
  v_expected_updated_at timestamptz;
  v_seen_item_keys text[];
  v_seen_item_line_ids uuid[];
  v_seen_index integer;
  v_new_item_id uuid;
  v_item_price_key text;
  v_batch_labels text[];
  v_imported_item_name text;
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

    select count(*)::integer,
           (array_agg(customer.id order by customer.created_at asc nulls last, customer.id))[1]
    into v_customer_matches, v_customer_id
    from public.customers as customer
    where customer.archived_at is null
      and public.normalize_live_identity(customer.facebook_name) = v_group.identity_key;

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

    begin
      select coalesce(sum(
        replace(
          btrim(
            regexp_replace(
              regexp_replace(btrim(row.value ->> 'downpayment'), '₱', '', 'g'),
              '[[:space:]]+', ' ', 'g'
            )
          ),
          ',', ''
        )::numeric
      ), 0)
      into v_group_downpayment
      from jsonb_array_elements(p_rows) with ordinality as row(value, position)
      where public.normalize_live_identity(row.value ->> 'facebookName') = v_group.identity_key
        and nullif(
          btrim(coalesce(nullif(row.value ->> 'liveBatch', ''), p_default_live_batch)),
          ''
        ) is not distinct from v_group.live_batch
        and nullif(btrim(row.value ->> 'downpayment'), '') is not null;
    exception
      when others then
        raise exception 'invalid_import_downpayment' using errcode = 'P0001';
    end;

    if v_group_downpayment < 0 or v_group_downpayment <> round(v_group_downpayment, 2) then
      raise exception 'invalid_import_downpayment' using errcode = 'P0001';
    end if;

    -- Automatically create new customer if not found
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
      notes, created_by, live_batch, import_batch_id, pricing_complete,
      reserved_at
    )
    values (
      v_customer_id, 'reserved', 0, 0, 0, 0, 0, null, v_user_id,
      v_group.live_batch, v_batch_id, false,
      now()
    )
    returning id into v_reservation_id;

    v_subtotal := 0;
    v_seen_item_keys := array[]::text[];
    v_seen_item_line_ids := array[]::uuid[];

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
        when others then
          v_quantity := 1;
      end;
      if v_quantity < 1 then
        v_quantity := 1;
      end if;

      -- Look up stock item by SKU
      select count(*)::integer, (array_agg(stock.id order by stock.id))[1]
      into v_stock_matches, v_stock_id
      from public.stock_items as stock
      where stock.archived_at is null
        and stock.is_active
        and upper(btrim(stock.sku)) = upper(btrim(v_input ->> 'itemCode'));

      if v_stock_matches = 0 and btrim(v_input ->> 'itemCode') ~ '^\d+$' then
        select count(*)::integer, (array_agg(stock.id order by stock.id))[1]
        into v_stock_matches, v_stock_id
        from public.stock_items as stock
        where stock.archived_at is null
          and stock.is_active
          and btrim(stock.sku) ~ '^\d+$'
          and ltrim(btrim(stock.sku), '0') = ltrim(btrim(v_input ->> 'itemCode'), '0');
      end if;

      -- If item does not exist in catalog, automatically create it
      if v_stock_matches = 0 then
        v_imported_item_name := coalesce(nullif(btrim(v_input ->> 'itemName'), ''), btrim(v_input ->> 'itemCode'));
        insert into public.stock_items (
          sku, name, description, category, price, quantity, is_active, created_by
        )
        values (
          btrim(v_input ->> 'itemCode'),
          left(v_imported_item_name, 160),
          'Created by Live Selling import.',
          'Gold',
          0,
          v_quantity,
          true,
          v_user_id
        )
        returning id into v_stock_id;
      end if;

      select stock.* into v_stock
      from public.stock_items as stock
      where stock.id = v_stock_id;

      begin
        v_unit_price := replace(
          btrim(
            regexp_replace(
              regexp_replace(btrim(v_input ->> 'price'), '₱', '', 'g'),
              '[[:space:]]+', ' ', 'g'
            )
          ),
          ',', ''
        )::numeric;
      exception
        when others then
          v_unit_price := v_stock.price;
      end;
      if v_unit_price is null or v_unit_price < 0 then
        v_unit_price := coalesce(v_stock.price, 0);
      end if;

      v_line_total := round(v_unit_price * v_quantity, 2);
      v_item_price_key := v_stock.id::text || '|' || to_char(v_unit_price, 'FM999999999990.00');
      v_seen_index := array_position(v_seen_item_keys, v_item_price_key);

      if v_seen_index is not null then
        update public.reservation_items
        set quantity = quantity + v_quantity,
            line_total = round((quantity + v_quantity) * unit_price, 2)
        where id = v_seen_item_line_ids[v_seen_index];
      else
        insert into public.reservation_items (
          reservation_id, stock_item_id, item_name, category,
          quantity, unit_price, line_total, image_path
        )
        values (
          v_reservation_id, v_stock.id, v_stock.name, v_stock.category,
          v_quantity, v_unit_price, v_line_total, v_stock.image_path
        )
        returning id into v_new_item_id;

        v_seen_item_keys := array_append(v_seen_item_keys, v_item_price_key);
        v_seen_item_line_ids := array_append(v_seen_item_line_ids, v_new_item_id);
      end if;

      v_subtotal := v_subtotal + v_line_total;
      v_item_count := v_item_count + v_quantity;
    end loop;

    update public.reservations
    set subtotal = v_subtotal,
        total = v_subtotal,
        balance = greatest(v_subtotal - v_group_downpayment, 0),
        downpayment = v_group_downpayment,
        pricing_complete = true
    where id = v_reservation_id;

    v_total_value := v_total_value + v_subtotal;
    v_reservation_count := v_reservation_count + 1;
  end loop;

  update public.reservation_import_batches
  set reservation_count = v_reservation_count,
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
end;
$function$;

grant execute on function public.confirm_live_order_import(text, text, text, jsonb) to authenticated;

commit;
