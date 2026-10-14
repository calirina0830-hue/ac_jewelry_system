-- Migration: 202610210001_delete_archived_reservations.sql
-- Provides an administrative procedure to delete archived reservations and their cascade dependencies.

BEGIN;

CREATE OR REPLACE FUNCTION public.delete_archived_reservation(
  p_reservation_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_reservation public.reservations%rowtype;
BEGIN
  IF v_user_id IS NULL OR public.current_profile_role() <> 'admin' THEN
    RAISE EXCEPTION 'not_authorized' USING errcode = '42501';
  END IF;

  SELECT reservation.*
  INTO v_reservation
  FROM public.reservations AS reservation
  WHERE reservation.id = p_reservation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'reservation_not_found' USING errcode = 'P0001';
  END IF;

  IF v_reservation.archived_at IS NULL THEN
    RAISE EXCEPTION 'reservation_not_archived' USING errcode = 'P0001';
  END IF;

  -- 1. Delete payment evidence for payments linked to this reservation
  DELETE FROM public.reservation_payment_evidence
  WHERE payment_id IN (
    SELECT id FROM public.reservation_payments WHERE reservation_id = p_reservation_id
  );

  -- 2. Delete reservation payments (which has ON DELETE RESTRICT from reservations)
  DELETE FROM public.reservation_payments
  WHERE reservation_id = p_reservation_id;

  -- 3. Delete shipment items for shipments of this reservation
  DELETE FROM public.reservation_shipment_items
  WHERE shipment_id IN (
    SELECT id FROM public.reservation_shipments WHERE reservation_id = p_reservation_id
  );

  -- 4. Delete shipments of this reservation
  DELETE FROM public.reservation_shipments
  WHERE reservation_id = p_reservation_id;

  -- 5. Delete reservation status history
  DELETE FROM public.reservation_status_history
  WHERE reservation_id = p_reservation_id;

  -- 6. Delete reservation items
  DELETE FROM public.reservation_items
  WHERE reservation_id = p_reservation_id;

  -- 7. Delete the reservation record itself
  DELETE FROM public.reservations
  WHERE id = p_reservation_id;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_archived_reservation(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.delete_archived_reservation(uuid) TO authenticated;

-- Function to purge all archived reservations at once
CREATE OR REPLACE FUNCTION public.delete_all_archived_reservations()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_res_ids uuid[];
  v_count integer := 0;
  v_id uuid;
BEGIN
  IF v_user_id IS NULL OR public.current_profile_role() <> 'admin' THEN
    RAISE EXCEPTION 'not_authorized' USING errcode = '42501';
  END IF;

  SELECT array_agg(id)
  INTO v_res_ids
  FROM public.reservations
  WHERE archived_at IS NOT NULL;

  IF v_res_ids IS NULL OR array_length(v_res_ids, 1) = 0 THEN
    RETURN 0;
  END IF;

  FOREACH v_id IN ARRAY v_res_ids
  LOOP
    PERFORM public.delete_archived_reservation(v_id);
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.delete_all_archived_reservations() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.delete_all_archived_reservations() TO authenticated;

COMMIT;
