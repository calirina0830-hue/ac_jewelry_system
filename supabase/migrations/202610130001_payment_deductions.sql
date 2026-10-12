-- Allow recording a negative payment (a deduction) that reduces total paid and
-- raises the remaining balance, while keeping the append-only ledger intact.
-- Positive payments keep every existing guard; deductions cannot drive paid below
-- zero and the settled-reservation check is skipped for negative amounts.
create or replace function public.record_reservation_payment(
  p_reservation_id uuid,
  p_expected_updated_at timestamptz,
  p_amount numeric,
  p_payment_method text,
  p_reference_no text,
  p_notes text,
  p_evidence jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_reservation public.reservations%rowtype;
  v_payment_id uuid;
  v_existing_paid numeric(12, 2);
  v_total_paid numeric(12, 2);
  v_balance numeric(12, 2);
  v_now timestamptz := timezone('utc', now());
  v_attachment jsonb;
  v_path text;
  v_original_name text;
  v_mime_type text;
  v_file_size bigint;
  v_paths text[] := array[]::text[];
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
     or p_amount = 0
     or abs(p_amount) > 9999999999.99
     or p_amount <> round(p_amount, 2)
     or char_length(coalesce(p_payment_method, '')) > 120
     or char_length(coalesce(p_reference_no, '')) > 200
     or char_length(coalesce(p_notes, '')) > 2000 then
    raise exception 'invalid_payment' using errcode = 'P0001';
  end if;
  if jsonb_typeof(coalesce(p_evidence, '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_evidence, '[]'::jsonb)) > 5 then
    raise exception 'invalid_payment_evidence' using errcode = 'P0001';
  end if;

  select coalesce(sum(payment.amount), 0)
  into v_existing_paid
  from public.reservation_payments as payment
  where payment.reservation_id = p_reservation_id
    and payment.voided_at is null;

  v_balance := greatest(v_reservation.total - v_existing_paid, 0);
  if p_amount > 0 then
    if v_balance <= 0 then
      raise exception 'reservation_already_settled' using errcode = 'P0001';
    end if;
    if p_amount > v_balance then
      raise exception 'payment_exceeds_balance' using errcode = 'P0001';
    end if;
  else
    if v_existing_paid + p_amount < 0 then
      raise exception 'deduction_exceeds_paid' using errcode = 'P0001';
    end if;
  end if;

  insert into public.reservation_payments (
    reservation_id, amount, payment_method, reference_no, evidence_path,
    notes, recorded_by, recorded_at
  ) values (
    p_reservation_id,
    p_amount,
    nullif(btrim(p_payment_method), ''),
    nullif(btrim(p_reference_no), ''),
    null,
    nullif(btrim(p_notes), ''),
    v_user_id,
    v_now
  ) returning id into v_payment_id;

  for v_attachment in
    select attachment.value
    from jsonb_array_elements(coalesce(p_evidence, '[]'::jsonb))
      as attachment(value)
  loop
    v_path := nullif(btrim(v_attachment ->> 'storage_path'), '');
    v_original_name := nullif(btrim(v_attachment ->> 'original_file_name'), '');
    v_mime_type := nullif(btrim(v_attachment ->> 'mime_type'), '');
    begin
      v_file_size := (v_attachment ->> 'file_size')::bigint;
    exception
      when invalid_text_representation or numeric_value_out_of_range then
        raise exception 'invalid_payment_evidence' using errcode = 'P0001';
    end;

    if v_path is null
       or char_length(v_path) > 1024
       or v_path = any(v_paths)
       or v_original_name is null
       or char_length(v_original_name) > 255
       or v_original_name ~ '[[:cntrl:]]'
       or v_mime_type not in ('image/jpeg', 'image/png', 'image/webp')
       or v_file_size is null
       or v_file_size < 1
       or v_file_size > 5242880
       or not exists (
         select 1
         from storage.objects as object
         where object.bucket_id = 'payment-evidence'
           and object.name = v_path
           and cardinality(storage.foldername(object.name)) = 2
           and (storage.foldername(object.name))[1] = v_user_id::text
           and (storage.foldername(object.name))[2] = p_reservation_id::text
       ) then
      raise exception 'invalid_payment_evidence' using errcode = 'P0001';
    end if;
    v_paths := array_append(v_paths, v_path);

    insert into public.reservation_payment_evidence (
      payment_id, storage_path, original_file_name, mime_type, file_size,
      uploaded_by, created_at
    ) values (
      v_payment_id, v_path, v_original_name, v_mime_type, v_file_size,
      v_user_id, v_now
    );
  end loop;

  v_total_paid := v_existing_paid + p_amount;
  v_balance := greatest(v_reservation.total - v_total_paid, 0);

  update public.reservations
  set
    downpayment = greatest(least(total, v_total_paid), 0),
    balance = v_balance,
    status = case when v_balance = 0 then 'paid' else status end,
    paid_at = case when v_balance = 0 then v_now else paid_at end,
    updated_at = v_now
  where id = p_reservation_id;

  if v_balance = 0 then
    insert into public.reservation_status_history (
      reservation_id, old_status, new_status, changed_by, changed_at, reason
    ) values (
      p_reservation_id, 'reserved', 'paid', v_user_id, v_now,
      'Final payment recorded'
    );
  end if;

  return jsonb_build_object(
    'paymentId', v_payment_id,
    'totalPaid', v_total_paid,
    'balance', v_balance,
    'fullySettled', v_balance = 0,
    'status', case when v_balance = 0 then 'paid' else 'reserved' end
  );
end;
$function$;

revoke all on function public.record_reservation_payment(
  uuid, timestamptz, numeric, text, text, text, jsonb
) from public, anon;
grant execute on function public.record_reservation_payment(
  uuid, timestamptz, numeric, text, text, text, jsonb
) to authenticated;

-- The ledger table rejects non-positive amounts. Allow negative deductions
-- while still refusing zero so the append-only record stays meaningful.
alter table public.reservation_payments
  drop constraint if exists reservation_payments_amount_positive;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'reservation_payments_amount_nonzero'
  ) then
    alter table public.reservation_payments
      add constraint reservation_payments_amount_nonzero
        check (amount <> 0);
  end if;
end
$$;