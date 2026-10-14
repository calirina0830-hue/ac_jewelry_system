-- Migration: 202610190001_ensure_shipping_and_release_rpcs.sql
-- Ensures that shipment and release functions are defined and accessible in public schema.

BEGIN;

CREATE SEQUENCE IF NOT EXISTS public.reservation_shipment_number_seq
  AS bigint START WITH 1 INCREMENT BY 1;

CREATE OR REPLACE FUNCTION public.next_shipment_number()
RETURNS text
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    'SHP-' ||
    to_char(timezone('Asia/Manila', now()), 'YYYY') ||
    '-' ||
    lpad(nextval('public.reservation_shipment_number_seq')::text, 6, '0');
$$;

GRANT EXECUTE ON FUNCTION public.next_shipment_number() TO authenticated;

CREATE OR REPLACE FUNCTION public.reservation_item_committed_quantity(
  p_reservation_item_id uuid
)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce(sum(items.quantity), 0)::integer
  FROM public.reservation_shipment_items as items
  JOIN public.reservation_shipments as shipment
    ON shipment.id = items.shipment_id
  WHERE items.reservation_item_id = p_reservation_item_id
    AND shipment.status in ('pending', 'shipped');
$$;

GRANT EXECUTE ON FUNCTION public.reservation_item_committed_quantity(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.reservation_downpayment_committed(
  p_reservation_id uuid
)
RETURNS numeric(12, 2)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT coalesce(
    sum(shipment.downpayment_applied),
    0
  )::numeric(12, 2)
  FROM public.reservation_shipments as shipment
  WHERE shipment.reservation_id = p_reservation_id
    AND shipment.status in ('pending', 'shipped');
$$;

GRANT EXECUTE ON FUNCTION public.reservation_downpayment_committed(uuid) TO authenticated;

-- Prepare reservation shipment with downpayment
CREATE OR REPLACE FUNCTION public.prepare_reservation_shipment(
  p_reservation_id uuid,
  p_items jsonb,
  p_downpayment_applied numeric DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_reservation public.reservations%rowtype;
  v_input jsonb;
  v_item public.reservation_items%rowtype;
  v_item_id uuid;
  v_quantity integer;
  v_committed integer;
  v_available integer;
  v_seen_ids uuid[] := array[]::uuid[];
  v_shipment_id uuid;
  v_shipment_no text;
  v_total_quantity integer := 0;
  v_released_values numeric(12, 2)[] := array[]::numeric(12, 2)[];
  v_released_value numeric(12, 2) := 0;
  v_max_applicable numeric(12, 2) := 0;
  v_committed_downpayment numeric(12, 2) := 0;
  v_allocated numeric(12, 2);
  v_remainder numeric(12, 2) := p_downpayment_applied;
  v_position integer := 0;
  v_count integer;
BEGIN
  IF v_user_id IS NULL
     OR public.current_profile_role() NOT IN ('admin', 'staff') THEN
    RAISE EXCEPTION 'not_authorized' USING errcode = '42501';
  END IF;

  IF jsonb_typeof(p_items) <> 'array'
     OR jsonb_array_length(p_items) < 1
     OR jsonb_array_length(p_items) > 200 THEN
    RAISE EXCEPTION 'invalid_release_items' USING errcode = 'P0001';
  END IF;

  IF p_downpayment_applied IS NULL
     OR p_downpayment_applied <> round(p_downpayment_applied, 2)
     OR p_downpayment_applied < 0
     OR p_downpayment_applied > 9999999999.99 THEN
    RAISE EXCEPTION 'invalid_downpayment_application' USING errcode = 'P0001';
  END IF;

  SELECT reservation.*
  INTO v_reservation
  FROM public.reservations AS reservation
  WHERE reservation.id = p_reservation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'reservation_not_found' USING errcode = 'P0001';
  END IF;
  IF v_reservation.archived_at IS NOT NULL
     OR v_reservation.status NOT IN ('reserved', 'paid', 'delivered') THEN
    RAISE EXCEPTION 'reservation_not_releasable' USING errcode = 'P0001';
  END IF;

  PERFORM items.id
  FROM public.reservation_items AS items
  WHERE items.reservation_id = p_reservation_id
  ORDER BY items.id
  FOR UPDATE;

  v_count := jsonb_array_length(p_items);

  FOR v_input IN
    SELECT item.value
    FROM jsonb_array_elements(p_items) WITH ORDINALITY AS item(value, position)
    ORDER BY item.position
  LOOP
    IF jsonb_typeof(v_input) <> 'object' THEN
      RAISE EXCEPTION 'invalid_release_items' USING errcode = 'P0001';
    END IF;

    BEGIN
      v_item_id := nullif(v_input ->> 'reservation_item_id', '')::uuid;
      v_quantity := (v_input ->> 'quantity')::integer;
    EXCEPTION
      WHEN invalid_text_representation OR numeric_value_out_of_range THEN
        RAISE EXCEPTION 'invalid_release_items' USING errcode = 'P0001';
    END;

    IF v_item_id IS NULL OR v_quantity IS NULL OR v_quantity < 1 THEN
      RAISE EXCEPTION 'invalid_release_items' USING errcode = 'P0001';
    END IF;

    IF v_item_id = ANY(v_seen_ids) THEN
      RAISE EXCEPTION 'duplicate_release_item' USING errcode = 'P0001';
    END IF;
    v_seen_ids := array_append(v_seen_ids, v_item_id);

    SELECT items.*
    INTO v_item
    FROM public.reservation_items AS items
    WHERE items.id = v_item_id
      AND items.reservation_id = p_reservation_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'release_item_not_found:%', v_item_id
        USING errcode = 'P0001';
    END IF;

    v_committed := public.reservation_item_committed_quantity(v_item_id);
    v_available := greatest(v_item.quantity - v_committed, 0);

    IF v_quantity > v_available THEN
      RAISE EXCEPTION 'insufficient_release_quantity:%:%:%',
        v_item_id, v_available, v_item.quantity
        USING errcode = 'P0001';
    END IF;

    v_released_value := round(
      v_item.unit_price * v_quantity
      - coalesce(v_item.discount, 0) * v_quantity / v_item.quantity,
      2
    );
    v_released_values := array_append(v_released_values, v_released_value);
    v_max_applicable := v_max_applicable + v_released_value;
  END LOOP;

  IF p_downpayment_applied > v_max_applicable THEN
    RAISE EXCEPTION 'downpayment_exceeds_released_value:%', v_max_applicable
      USING errcode = 'P0001';
  END IF;

  v_committed_downpayment :=
    public.reservation_downpayment_committed(p_reservation_id);

  IF v_committed_downpayment + p_downpayment_applied > v_reservation.downpayment THEN
    RAISE EXCEPTION 'insufficient_downpayment:%:%:%',
      v_reservation.downpayment,
      v_committed_downpayment,
      p_downpayment_applied
      USING errcode = 'P0001';
  END IF;

  INSERT INTO public.reservation_shipments (
    reservation_id,
    status,
    downpayment_applied,
    created_by
  )
  VALUES (
    p_reservation_id,
    'pending',
    p_downpayment_applied,
    v_user_id
  )
  RETURNING id, shipment_no INTO v_shipment_id, v_shipment_no;

  FOR v_input IN
    SELECT item.value
    FROM jsonb_array_elements(p_items) WITH ORDINALITY AS item(value, position)
    ORDER BY item.position
  LOOP
    v_position := v_position + 1;
    v_item_id := (v_input ->> 'reservation_item_id')::uuid;
    v_quantity := (v_input ->> 'quantity')::integer;

    IF v_max_applicable = 0 OR p_downpayment_applied = 0 THEN
      v_allocated := 0;
    ELSIF v_position = v_count THEN
      v_allocated := greatest(v_remainder, 0);
    ELSE
      v_allocated := round(
        p_downpayment_applied * (v_released_values[v_position] / v_max_applicable),
        2
      );
      IF v_allocated > v_remainder THEN
        v_allocated := v_remainder;
      END IF;
      v_remainder := v_remainder - v_allocated;
    END IF;

    INSERT INTO public.reservation_shipment_items (
      shipment_id,
      reservation_item_id,
      quantity,
      ordered_at,
      downpayment_allocated
    )
    SELECT
      v_shipment_id,
      items.id,
      v_quantity,
      items.ordered_at,
      v_allocated
    FROM public.reservation_items AS items
    WHERE items.id = v_item_id;
  END LOOP;

  SELECT coalesce(sum(items.quantity), 0)::integer
  INTO v_total_quantity
  FROM public.reservation_shipment_items AS items
  WHERE items.shipment_id = v_shipment_id;

  RETURN jsonb_build_object(
    'shipmentId', v_shipment_id,
    'shipmentNo', v_shipment_no,
    'status', 'pending',
    'itemCount', jsonb_array_length(p_items),
    'totalQuantity', v_total_quantity,
    'downpaymentApplied', p_downpayment_applied
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.prepare_reservation_shipment(uuid, jsonb, numeric) TO authenticated;

-- Wrapper for 2-argument call
CREATE OR REPLACE FUNCTION public.prepare_reservation_shipment(
  p_reservation_id uuid,
  p_items jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN public.prepare_reservation_shipment(p_reservation_id, p_items, 0);
END;
$$;

GRANT EXECUTE ON FUNCTION public.prepare_reservation_shipment(uuid, jsonb) TO authenticated;

-- Confirm reservation shipment
CREATE OR REPLACE FUNCTION public.confirm_reservation_shipment(
  p_shipment_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_shipment public.reservation_shipments%rowtype;
  v_now timestamptz := timezone('utc', now());
BEGIN
  IF v_user_id IS NULL
     OR public.current_profile_role() NOT IN ('admin', 'staff') THEN
    RAISE EXCEPTION 'not_authorized' USING errcode = '42501';
  END IF;

  SELECT shipment.*
  INTO v_shipment
  FROM public.reservation_shipments AS shipment
  WHERE shipment.id = p_shipment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'shipment_not_found' USING errcode = 'P0001';
  END IF;
  IF v_shipment.status <> 'pending' THEN
    RAISE EXCEPTION 'invalid_shipment_transition' USING errcode = 'P0001';
  END IF;

  UPDATE public.reservation_shipments
  SET
    status = 'shipped',
    shipped_at = v_now
  WHERE id = p_shipment_id;

  RETURN jsonb_build_object(
    'shipmentId', v_shipment.id,
    'shipmentNo', v_shipment.shipment_no,
    'status', 'shipped',
    'shippedAt', v_now
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.confirm_reservation_shipment(uuid) TO authenticated;

-- Cancel reservation shipment
CREATE OR REPLACE FUNCTION public.cancel_reservation_shipment(
  p_shipment_id uuid,
  p_reason text DEFAULT null
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_role public.profile_role;
  v_shipment public.reservation_shipments%rowtype;
  v_now timestamptz := timezone('utc', now());
  v_reason text := nullif(btrim(p_reason), '');
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'not_authorized' USING errcode = '42501';
  END IF;

  v_role := public.current_profile_role();

  IF v_role NOT IN ('admin', 'staff') THEN
    RAISE EXCEPTION 'not_authorized' USING errcode = '42501';
  END IF;
  IF v_reason IS NOT NULL AND char_length(v_reason) > 1000 THEN
    RAISE EXCEPTION 'invalid_cancel_reason' USING errcode = 'P0001';
  END IF;

  SELECT shipment.*
  INTO v_shipment
  FROM public.reservation_shipments AS shipment
  WHERE shipment.id = p_shipment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'shipment_not_found' USING errcode = 'P0001';
  END IF;
  IF v_shipment.status = 'cancelled' THEN
    RETURN jsonb_build_object(
      'shipmentId', v_shipment.id,
      'shipmentNo', v_shipment.shipment_no,
      'status', 'cancelled'
    );
  END IF;
  IF v_shipment.status = 'shipped' AND v_role <> 'admin' THEN
    RAISE EXCEPTION 'not_authorized' USING errcode = '42501';
  END IF;

  UPDATE public.reservation_shipments
  SET
    status = 'cancelled',
    cancelled_at = v_now,
    cancel_reason = v_reason
  WHERE id = p_shipment_id;

  RETURN jsonb_build_object(
    'shipmentId', v_shipment.id,
    'shipmentNo', v_shipment.shipment_no,
    'status', 'cancelled',
    'cancelledAt', v_now
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.cancel_reservation_shipment(uuid, text) TO authenticated;

-- Atomic item release function
CREATE OR REPLACE FUNCTION public.release_reservation_items(
  p_reservation_id uuid,
  p_items jsonb,
  p_release_date timestamptz DEFAULT timezone('utc', now()),
  p_downpayment_applied numeric DEFAULT 0,
  p_notes text DEFAULT null
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_prepared jsonb;
  v_shipment_id uuid;
  v_shipment_no text;
  v_notes text := nullif(btrim(p_notes), '');
  v_release_date timestamptz := coalesce(p_release_date, timezone('utc', now()));
BEGIN
  IF v_user_id IS NULL
     OR public.current_profile_role() NOT IN ('admin', 'staff') THEN
    RAISE EXCEPTION 'not_authorized' USING errcode = '42501';
  END IF;

  IF v_notes IS NOT NULL AND char_length(v_notes) > 2000 THEN
    RAISE EXCEPTION 'notes_too_long' USING errcode = 'P0001';
  END IF;

  v_prepared := public.prepare_reservation_shipment(
    p_reservation_id,
    p_items,
    p_downpayment_applied
  );

  v_shipment_id := (v_prepared ->> 'shipmentId')::uuid;
  v_shipment_no := v_prepared ->> 'shipmentNo';

  UPDATE public.reservation_shipments
  SET
    status = 'shipped',
    shipped_at = v_release_date,
    notes = v_notes,
    updated_at = timezone('utc', now())
  WHERE id = v_shipment_id;

  RETURN jsonb_build_object(
    'shipmentId', v_shipment_id,
    'shipmentNo', v_shipment_no,
    'status', 'shipped',
    'shippedAt', v_release_date,
    'itemCount', (v_prepared ->> 'itemCount')::integer,
    'totalQuantity', (v_prepared ->> 'totalQuantity')::integer,
    'downpaymentApplied', (v_prepared ->> 'downpaymentApplied')::numeric
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.release_reservation_items(uuid, jsonb, timestamptz, numeric, text) TO authenticated;

COMMIT;
