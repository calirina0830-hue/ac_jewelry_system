begin;

-- Live Selling template v2: FB Name / Item Code / Price / Date / Downpayment.
-- The imported Price becomes the confirmed selling price, the imported Date
-- becomes the reservation date, and a positive Downpayment is recorded through
-- the authoritative payment ledger RPC (record_reservation_payment), which
-- keeps partial payments Reserved and only transitions to Paid when the
-- balance reaches zero through the existing workflow.

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
  v_stock public.stock_items%rowtype;
  v_stock_matches integer;
  v_stock_id uuid;
  v_quantity integer;
  v_unit_price numeric(12, 2);
  v_line_total numeric(12, 2);
  v_group_downpayment numeric(12, 2);
  v_reserved_at timestamptz;
  v_date_text text;
  v_year integer;
  v_month integer;
  v_day integer;
  v_expected_updated_at timestamptz;
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

    -- Reservation date: first non-empty Date value within the group.
    select nullif(btrim(row.value ->> 'date'), '')
    into v_date_text
    from jsonb_array_elements(p_rows) with ordinality as row(value, position)
    where public.normalize_live_identity(row.value ->> 'facebookName') = v_group.identity_key
      and nullif(
        btrim(coalesce(nullif(row.value ->> 'liveBatch', ''), p_default_live_batch)),
        ''
      ) is not distinct from v_group.live_batch
      and nullif(btrim(row.value ->> 'date'), '') is not null
    order by row.position
    limit 1;

    if v_date_text is null then
      v_reserved_at := timezone('utc', now());
    else
      -- Strict YYYY-MM-DD calendar validation without exception handling.
      -- The regex bounds each part to digits only, so the integer casts below
      -- can never fail; impossible calendar dates are rejected arithmetically.
      if v_date_text !~ '^\d{4}-\d{2}-\d{2}$' then
        raise exception 'invalid_import_date' using errcode = 'P0001';
      end if;

      v_year := substr(v_date_text, 1, 4)::int;
      v_month := substr(v_date_text, 6, 2)::int;
      v_day := substr(v_date_text, 9, 2)::int;

if v_year < 1
          or v_month not between 1 and 12
          or v_day < 1
          or v_day > (
            case v_month
              when 2 then case
                when (v_year % 4 = 0 and v_year % 100 <> 0) or v_year % 400 = 0 then 29
                else 28
              end
              when 4 then 30
              when 6 then 30
              when 9 then 30
              when 11 then 30
              else 31
            end
          ) then
        raise exception 'invalid_import_date' using errcode = 'P0001';
      end if;

      v_reserved_at := timezone(
        'Asia/Manila',
        make_date(v_year, v_month, v_day)::timestamp
      );
    end if;

    -- Downpayment: sum of the group's Downpayment values; validated before use.
    -- Downpayment is OPTIONAL: blank cells are excluded from the sum and simply
    -- leave the reservation unpaid (Amount Paid 0, Balance = total). Zero and
    -- 0.00 behave the same way because the payment call below requires > 0.
    begin
      select coalesce(sum(btrim(row.value ->> 'downpayment')::numeric), 0)
      into v_group_downpayment
      from jsonb_array_elements(p_rows) with ordinality as row(value, position)
      where public.normalize_live_identity(row.value ->> 'facebookName') = v_group.identity_key
        and nullif(
          btrim(coalesce(nullif(row.value ->> 'liveBatch', ''), p_default_live_batch)),
          ''
        ) is not distinct from v_group.live_batch
        and nullif(btrim(row.value ->> 'downpayment'), '') is not null;

      -- Any value that IS present must still be a valid non-negative amount.
      if exists (
        select 1
        from jsonb_array_elements(p_rows) with ordinality as row(value, position)
        where public.normalize_live_identity(row.value ->> 'facebookName') = v_group.identity_key
          and nullif(
            btrim(coalesce(nullif(row.value ->> 'liveBatch', ''), p_default_live_batch)),
            ''
          ) is not distinct from v_group.live_batch
          and nullif(btrim(row.value ->> 'downpayment'), '') is not null
          and btrim(row.value ->> 'downpayment')::numeric < 0
      ) then
        raise exception 'invalid_import_downpayment' using errcode = 'P0001';
      end if;
    exception
      when invalid_text_representation or numeric_value_out_of_range then
        raise exception 'invalid_import_downpayment' using errcode = 'P0001';
    end;

    if v_group_downpayment < 0
       or v_group_downpayment <> round(v_group_downpayment, 2) then
      raise exception 'invalid_import_downpayment' using errcode = 'P0001';
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
      notes, created_by, live_batch, import_batch_id, pricing_complete,
      reserved_at
    )
    values (
      v_customer_id, 'reserved', 0, 0, 0, 0, 0, null, v_user_id,
      v_group.live_batch, v_batch_id, false,
      v_reserved_at
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

      -- Selling price: the file's Price column; fall back to catalog price.
      if nullif(btrim(v_input ->> 'price'), '') is null then
        v_unit_price := v_stock.price;
      else
        if btrim(v_input ->> 'price') !~ '^\d{1,10}(\.\d{1,2})?$' then
          raise exception 'invalid_import_price' using errcode = 'P0001';
        end if;
        begin
          v_unit_price := btrim(v_input ->> 'price')::numeric;
        exception
          when invalid_text_representation or numeric_value_out_of_range then
            raise exception 'invalid_import_price' using errcode = 'P0001';
        end;
      end if;

      if v_unit_price < 0
         or v_unit_price > 9999999999.99
         or v_unit_price <> round(v_unit_price, 2) then
        raise exception 'invalid_import_price' using errcode = 'P0001';
      end if;

      v_line_total := v_unit_price * v_quantity;

      if v_line_total < 0 or v_line_total > 9999999999.99 then
        raise exception 'reservation_total_too_large' using errcode = 'P0001';
      end if;

      insert into public.reservation_items (
        reservation_id, stock_item_id, item_name, sku, category, quantity,
        unit_price, discount, line_total, image_path, price_confirmed
      )
      values (
        v_reservation_id, v_stock.id, v_stock.name, v_stock.sku, v_stock.category,
        v_quantity, v_unit_price, 0, v_line_total, v_stock.image_path, true
      );

      v_subtotal := v_subtotal + v_line_total;
      v_item_count := v_item_count + 1;
    end loop;

    if v_subtotal > 9999999999.99 then
      raise exception 'reservation_total_too_large' using errcode = 'P0001';
    end if;

    update public.reservations
    set subtotal = v_subtotal, discount = 0, total = v_subtotal,
        balance = v_subtotal
    where id = v_reservation_id
    returning updated_at into v_expected_updated_at;

    insert into public.reservation_status_history (
      reservation_id, old_status, new_status, changed_by
    )
    values (v_reservation_id, null, 'reserved', v_user_id);

    -- Record any downpayment through the existing authoritative ledger flow.
    -- Partial downpayments keep the reservation Reserved; only a settled
    -- balance transitions it to Paid via the existing workflow.
    if v_group_downpayment > 0 then
      perform public.record_reservation_payment(
        v_reservation_id,
        v_expected_updated_at,
        v_group_downpayment,
        null,
        null,
        'Live Selling import downpayment.'
      );
    end if;

    v_reservation_count := v_reservation_count + 1;
    v_total_value := v_total_value + v_subtotal;
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

commit;
