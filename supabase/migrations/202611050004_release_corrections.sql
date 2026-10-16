begin;

-- Keep release corrections auditable. A corrected release keeps its original
-- shipment row; only its editable details are changed and the correction is
-- recorded separately from the customer's release notes.
alter table public.reservation_shipments
  add column if not exists correction_reason text,
  add column if not exists corrected_by uuid references public.profiles(id),
  add column if not exists corrected_at timestamptz;

do $migration$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'reservation_shipments_correction_reason_length'
      and conrelid = 'public.reservation_shipments'::regclass
  ) then
    alter table public.reservation_shipments
      add constraint reservation_shipments_correction_reason_length
      check (correction_reason is null or char_length(correction_reason) between 3 and 1000);
  end if;
end;
$migration$;

create or replace function public.edit_reservation_shipment(
  p_shipment_id uuid,
  p_expected_updated_at timestamptz,
  p_shipped_at timestamptz,
  p_notes text,
  p_correction_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_role text;
  v_shipment public.reservation_shipments%rowtype;
  v_notes text := nullif(btrim(p_notes), '');
  v_reason text := nullif(btrim(p_correction_reason), '');
  v_now timestamptz := timezone('utc', now());
begin
  v_role := public.current_profile_role()::text;
  if v_user_id is null or v_role not in ('admin', 'staff') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_reason is null or char_length(v_reason) < 3 or char_length(v_reason) > 1000 then
    raise exception 'invalid_correction_reason' using errcode = 'P0001';
  end if;
  if p_shipped_at is null then
    raise exception 'invalid_release_date' using errcode = 'P0001';
  end if;
  if v_notes is not null and char_length(v_notes) > 2000 then
    raise exception 'notes_too_long' using errcode = 'P0001';
  end if;

  select shipment.*
  into v_shipment
  from public.reservation_shipments as shipment
  where shipment.id = p_shipment_id
  for update;

  if not found then
    raise exception 'shipment_not_found' using errcode = 'P0001';
  end if;
  if v_shipment.status <> 'shipped' then
    raise exception 'shipment_not_editable' using errcode = 'P0001';
  end if;
  if v_shipment.updated_at is distinct from p_expected_updated_at then
    raise exception 'stale_shipment' using errcode = 'P0001';
  end if;

  update public.reservation_shipments
  set
    shipped_at = p_shipped_at,
    notes = v_notes,
    correction_reason = v_reason,
    corrected_by = v_user_id,
    corrected_at = v_now,
    updated_at = v_now
  where id = p_shipment_id;

  return jsonb_build_object(
    'shipmentId', v_shipment.id,
    'shipmentNo', v_shipment.shipment_no,
    'status', v_shipment.status,
    'shippedAt', p_shipped_at
  );
end;
$function$;

revoke all on function public.edit_reservation_shipment(
  uuid, timestamptz, timestamptz, text, text
) from public, anon;
grant execute on function public.edit_reservation_shipment(
  uuid, timestamptz, timestamptz, text, text
) to authenticated;

commit;
