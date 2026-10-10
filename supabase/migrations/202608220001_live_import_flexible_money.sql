begin;

-- Flexible Philippine money formats and forgiving customer matching for Live
-- Selling imports.
--
-- Real-world sheets write prices as "2,100", "2,100.00", " 2,100 ", "₱2,100",
-- or "₱ 2,100.50". The preview parser already normalizes these; this migration
-- applies the EXACT SAME normalization inside confirm_live_order_import so a
-- value that passed preview validation can never be rejected by the database:
--
--   1. trim the text,
--   2. remove the peso sign,
--   3. collapse ordinary spaces,
--   4. remove commas used as thousands separators - commas are accepted only
--      in strict three-digit groups, so "1,200.50" -> 1200.50 while "1,20"
--      and "2,1x0" stay invalid instead of silently changing value,
--   5. validate the remaining numeric string (>= 0, at most two decimal
--      places, within the numeric(12,2) column limits).
--
-- Customer matching is forgiving and never blocks on identity formatting:
-- normalize_live_identity trims, collapses repeated internal whitespace, and
-- compares case-insensitively, so CALI / cali / " Cali " / "Maria  Santos"
-- resolve to ONE identity. When several active records share that identity,
-- the OLDEST active record is reused deterministically (ties broken by id);
-- the import is never rejected as ambiguous and no customer record is ever
-- merged, modified, or deleted. Zero matches create one new customer from the
-- imported FB Name. Rows group by normalized identity so repeated rows with
-- different capitalization merge quantities into one reservation item line;
-- different selling prices always stay separate snapshot lines.
--
-- Downpayment stays optional: blank or zero records nothing; positive amounts
-- are recorded through the existing payment ledger unchanged.

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
  v_money_text text;
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

  -- Lock every stock row the import can resolve to: exact trimmed SKUs plus,
  -- for numeric-only imported codes, any active numeric SKU whose digit
  -- sequence equals the imported digits after stripping leading zeros.
  perform stock.id
  from public.stock_items as stock
  where upper(btrim(stock.sku)) in (
    select distinct upper(btrim(row.value ->> 'itemCode'))
    from jsonb_array_elements(p_rows) as row(value)
  )
     or (
       btrim(stock.sku) ~ '^\d+$'
       and exists (
         select 1
         from jsonb_array_elements(p_rows) as row(value)
         where btrim(row.value ->> 'itemCode') ~ '^\d+$'
           and ltrim(btrim(stock.sku), '0')
             = ltrim(btrim(row.value ->> 'itemCode'), '0')
       )
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

  -- One audit row per confirmed import event. Re-uploading the same file is
  -- allowed; each confirmation records its own tracking row.
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

    -- Forgiving identity match: every active customer whose normalized FB
    -- name equals the imported identity matches. When several case-equivalent
    -- records exist, reuse the OLDEST active record deterministically (ties
    -- broken by id) instead of blocking the import. No customer record is
    -- ever merged, modified, or deleted.
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

    -- Downpayment: sum of the group's Downpayment values after flexible money
    -- normalization; validated before use. Downpayment is OPTIONAL: blank
    -- cells are excluded from the sum and simply leave the reservation unpaid
    -- (Amount Paid 0, Balance = total). Zero and 0.00 behave the same way
    -- because the payment call below requires > 0.
    begin
      if exists (
        select 1
        from jsonb_array_elements(p_rows) with ordinality as row(value, position)
        where public.normalize_live_identity(row.value ->> 'facebookName') = v_group.identity_key
          and nullif(
            btrim(coalesce(nullif(row.value ->> 'liveBatch', ''), p_default_live_batch)),
            ''
          ) is not distinct from v_group.live_batch
          and nullif(btrim(row.value ->> 'downpayment'), '') is not null
          and btrim(
                regexp_replace(
                  regexp_replace(btrim(row.value ->> 'downpayment'), '₱', '', 'g'),
                  '[[:space:]]+', ' ', 'g'
                )
              ) !~ '^(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$'
      ) then
        raise exception 'invalid_import_downpayment' using errcode = 'P0001';
      end if;

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

      -- Quantity: blank defaults to 1; otherwise a positive whole number.
      -- Zero, negatives, and decimals fail the integer cast or range check.
      begin
        v_quantity := coalesce(nullif(btrim(v_input ->> 'quantity'), '')::integer, 1);
      exception
        when invalid_text_representation or numeric_value_out_of_range then
          raise exception 'invalid_quantity' using errcode = 'P0001';
      end;
      if v_quantity < 1 then
        raise exception 'invalid_quantity' using errcode = 'P0001';
      end if;

      -- Exact case-insensitive trimmed SKU match first.
      select count(*)::integer, (array_agg(stock.id order by stock.id))[1]
      into v_stock_matches, v_stock_id
      from public.stock_items as stock
      where stock.archived_at is null
        and stock.is_active
        and upper(btrim(stock.sku)) = upper(btrim(v_input ->> 'itemCode'));

      -- Leading-zero compatibility for numeric-only Item Codes only. Compare
      -- digit sequences textually so 001879 and 1879 resolve to one record;
      -- multiple normalized matches stay ambiguous and block the import.
      if v_stock_matches = 0
         and btrim(v_input ->> 'itemCode') ~ '^\d+$' then
        select count(*)::integer, (array_agg(stock.id order by stock.id))[1]
        into v_stock_matches, v_stock_id
        from public.stock_items as stock
        where stock.archived_at is null
          and stock.is_active
          and btrim(stock.sku) ~ '^\d+$'
          and ltrim(btrim(stock.sku), '0')
            = ltrim(btrim(v_input ->> 'itemCode'), '0');
      end if;

      if v_stock_matches = 0 then
        raise exception 'item_not_found:%', left(v_input ->> 'itemCode', 64)
          using errcode = 'P0001';
      elsif v_stock_matches > 1 then
        raise exception 'item_ambiguous:%', left(v_input ->> 'itemCode', 64)
          using errcode = 'P0001';
      end if;

      select stock.* into v_stock
      from public.stock_items as stock
      where stock.id = v_stock_id;

      -- Selling price: the file's Price column; fall back to catalog price.
      -- Flexible money normalization mirrors the app parser exactly: strip
      -- the peso sign, collapse surrounding/internal whitespace to single
      -- spaces, trim, then accept comma thousands separators ONLY in strict
      -- three-digit groups so digits and the decimal point survive intact
      -- ("2,100" -> 2100; "1,200.50" -> 1200.50; "2 100" stays invalid).
      v_money_text := btrim(
        regexp_replace(
          regexp_replace(coalesce(v_input ->> 'price', ''), '₱', '', 'g'),
          '[[:space:]]+', ' ', 'g'
        )
      );

      if v_money_text = '' then
        v_unit_price := v_stock.price;
      else
        if v_money_text !~ '^(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$' then
          raise exception 'invalid_import_price' using errcode = 'P0001';
        end if;
        begin
          v_unit_price := replace(v_money_text, ',', '')::numeric;
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

      -- Exact duplicate rows inside this import MERGE instead of being
      -- rejected: repeated rows with the same stock item + selling price add
      -- their quantity onto ONE reservation_items line and its trusted line
      -- total is recomputed from the stored unit price (quantity x unit
      -- price). Different selling prices keep separate snapshot lines.
      -- Re-importing a customer + item + price that already sits in an active
      -- Reserved reservation is also allowed: the import simply creates an
      -- additional Reserved snapshot instead of blocking the batch.
      v_item_price_key := v_stock_id::text || '|' || v_unit_price::text;
      v_seen_index := array_position(v_seen_item_keys, v_item_price_key);
      if v_seen_index is not null then
        update public.reservation_items
        set quantity = quantity + v_quantity,
            line_total = unit_price * (quantity + v_quantity)
        where id = v_seen_item_line_ids[v_seen_index];
      else
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
        )
        returning id into v_new_item_id;

        v_seen_item_keys := array_append(v_seen_item_keys, v_item_price_key);
        v_seen_item_line_ids := array_append(
          v_seen_item_line_ids,
          v_new_item_id
        );
        v_item_count := v_item_count + 1;
      end if;
      -- The group subtotal always accumulates the full merged amount:
      -- every physical row contributes quantity x price exactly once.
      v_subtotal := v_subtotal + v_unit_price * v_quantity;
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
end;
$function$;

revoke all on function public.confirm_live_order_import(text, text, text, jsonb)
  from public, anon;
grant execute on function public.confirm_live_order_import(text, text, text, jsonb)
  to authenticated;

commit;
