begin;

create table public.reservation_payment_evidence (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null
    references public.reservation_payments (id) on delete cascade,
  storage_path text not null unique,
  original_file_name text not null,
  mime_type text not null,
  file_size bigint,
  uploaded_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  constraint reservation_payment_evidence_path_length
    check (char_length(storage_path) between 1 and 1024),
  constraint reservation_payment_evidence_name_length
    check (char_length(original_file_name) between 1 and 255),
  constraint reservation_payment_evidence_mime_type
    check (mime_type in ('image/jpeg', 'image/png', 'image/webp')),
  constraint reservation_payment_evidence_file_size
    check (file_size is null or file_size between 1 and 5242880)
);

create index reservation_payment_evidence_payment_id_idx
  on public.reservation_payment_evidence (payment_id, created_at);

revoke all on table public.reservation_payment_evidence from anon, authenticated;
grant select on table public.reservation_payment_evidence to authenticated;
alter table public.reservation_payment_evidence enable row level security;

create policy "reservation_payment_evidence_select_authenticated"
on public.reservation_payment_evidence
for select
to authenticated
using (auth.uid() is not null);

-- Normalize historical downpayments before all future totals are derived from payments.
insert into public.reservation_payments (
  reservation_id,
  amount,
  notes,
  recorded_by,
  recorded_at
)
select
  reservation.id,
  least(reservation.downpayment, reservation.total) - ledger.active_total,
  'Legacy downpayment migrated to the payment ledger.',
  reservation.created_by,
  coalesce(reservation.paid_at, reservation.reserved_at)
from public.reservations as reservation
cross join lateral (
  select coalesce(sum(payment.amount), 0)::numeric(12, 2) as active_total
  from public.reservation_payments as payment
  where payment.reservation_id = reservation.id
    and payment.voided_at is null
) as ledger
where least(reservation.downpayment, reservation.total) > ledger.active_total
  and reservation.total > 0
  and least(reservation.downpayment, reservation.total) - ledger.active_total > 0;

-- Preserve every legacy evidence object while normalizing attachment metadata.
insert into public.reservation_payment_evidence (
  payment_id,
  storage_path,
  original_file_name,
  mime_type,
  file_size,
  uploaded_by,
  created_at
)
select
  payment.id,
  payment.evidence_path,
  regexp_replace(payment.evidence_path, '^.*/', ''),
  case
    when lower(payment.evidence_path) ~ '\\.png$' then 'image/png'
    when lower(payment.evidence_path) ~ '\\.webp$' then 'image/webp'
    else 'image/jpeg'
  end,
  null,
  payment.recorded_by,
  payment.recorded_at
from public.reservation_payments as payment
where payment.evidence_path is not null
on conflict (storage_path) do nothing;

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
     or p_amount <= 0
     or p_amount > 9999999999.99
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
  if v_balance <= 0 then
    raise exception 'reservation_already_settled' using errcode = 'P0001';
  end if;
  if p_amount > v_balance then
    raise exception 'payment_exceeds_balance' using errcode = 'P0001';
  end if;

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
    null,
    nullif(btrim(p_notes), ''),
    v_user_id,
    v_now
  )
  returning id into v_payment_id;

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
           and (storage.foldername(object.name))[1] = v_user_id::text
       ) then
      raise exception 'invalid_payment_evidence' using errcode = 'P0001';
    end if;
    v_paths := array_append(v_paths, v_path);

    insert into public.reservation_payment_evidence (
      payment_id,
      storage_path,
      original_file_name,
      mime_type,
      file_size,
      uploaded_by,
      created_at
    ) values (
      v_payment_id,
      v_path,
      v_original_name,
      v_mime_type,
      v_file_size,
      v_user_id,
      v_now
    );
  end loop;

  v_total_paid := v_existing_paid + p_amount;
  v_balance := greatest(v_reservation.total - v_total_paid, 0);

  update public.reservations
  set
    downpayment = least(total, v_total_paid),
    balance = v_balance
  where id = p_reservation_id;

  return jsonb_build_object(
    'paymentId', v_payment_id,
    'totalPaid', v_total_paid,
    'balance', v_balance,
    'fullySettled', v_balance = 0
  );
end;
$function$;

revoke all on function public.record_reservation_payment(
  uuid, timestamptz, numeric, text, text, text, jsonb
) from public, anon;
grant execute on function public.record_reservation_payment(
  uuid, timestamptz, numeric, text, text, text, jsonb
) to authenticated;

create or replace function public.bulk_record_reservation_payments(p_payments jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_input jsonb;
  v_ids uuid[] := array[]::uuid[];
  v_reservation_id uuid;
  v_result jsonb;
  v_results jsonb := '[]'::jsonb;
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

    v_result := public.record_reservation_payment(
      v_reservation_id,
      (v_input ->> 'expected_updated_at')::timestamptz,
      (v_input ->> 'amount')::numeric,
      v_input ->> 'payment_method',
      v_input ->> 'reference_no',
      v_input ->> 'notes',
      coalesce(v_input -> 'evidence', '[]'::jsonb)
    );
    v_results := v_results || jsonb_build_array(
      v_result || jsonb_build_object('reservationId', v_reservation_id)
    );
  end loop;

  return jsonb_build_object(
    'reservationCount', jsonb_array_length(p_payments),
    'results', v_results
  );
exception
  when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'invalid_bulk_payment' using errcode = 'P0001';
end;
$function$;

revoke all on function public.bulk_record_reservation_payments(jsonb)
  from public, anon;
grant execute on function public.bulk_record_reservation_payments(jsonb)
  to authenticated;

create or replace function public.mark_reservation_paid(
  p_reservation_id uuid,
  p_expected_updated_at timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_reservation public.reservations%rowtype;
  v_total_paid numeric(12, 2);
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
    raise exception 'invalid_status_transition' using errcode = 'P0001';
  end if;
  if v_reservation.updated_at is distinct from p_expected_updated_at then
    raise exception 'stale_reservation' using errcode = 'P0001';
  end if;
  if not v_reservation.pricing_complete then
    raise exception 'pricing_incomplete' using errcode = 'P0001';
  end if;
  if v_reservation.total <= 0 then
    raise exception 'invalid_reservation_total' using errcode = 'P0001';
  end if;

  select coalesce(sum(payment.amount), 0)
  into v_total_paid
  from public.reservation_payments as payment
  where payment.reservation_id = p_reservation_id
    and payment.voided_at is null;

  if v_total_paid < v_reservation.total then
    raise exception 'underpaid_reservation' using errcode = 'P0001';
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
  ) values (
    p_reservation_id,
    'reserved',
    'paid',
    v_user_id,
    v_now
  );

  return p_reservation_id;
end;
$function$;

revoke all on function public.mark_reservation_paid(uuid, timestamptz)
  from public, anon;
grant execute on function public.mark_reservation_paid(uuid, timestamptz)
  to authenticated;

-- Retire the full-payment-only entry points so callers cannot bypass the new flow.
revoke execute on function public.record_reservation_payment_and_mark_paid(
  uuid, timestamptz, numeric, text, text, text, text
) from authenticated;
revoke execute on function public.bulk_mark_reservations_paid(jsonb)
  from authenticated;

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
  v_total_paid numeric(12, 2);
begin
  if v_user_id is null or public.current_profile_role() <> 'admin' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_reason is null
     or char_length(v_reason) < 3
     or char_length(v_reason) > 1000 then
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
    select coalesce(sum(payment.amount), 0)
    into v_total_paid
    from public.reservation_payments as payment
    where payment.reservation_id = v_id
      and payment.voided_at is null;

    update public.reservations
    set
      status = 'reserved',
      downpayment = least(total, v_total_paid),
      balance = greatest(total - v_total_paid, 0),
      paid_at = null
    where id = v_id;

    insert into public.reservation_status_history (
      reservation_id,
      old_status,
      new_status,
      changed_by,
      changed_at,
      reason
    ) values (v_id, 'paid', 'reserved', v_user_id, v_now, v_reason);
  end loop;

  return array_length(p_reservation_ids, 1);
end;
$function$;

revoke all on function public.bulk_revert_paid_reservations(uuid[], text)
  from public, anon;
grant execute on function public.bulk_revert_paid_reservations(uuid[], text)
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
        and not exists (
          select 1
          from public.reservation_payment_evidence as evidence
          where evidence.payment_id = payment.id
        )
    )::bigint as payments_awaiting_evidence
  from public.reservation_payments as payment;
$function$;

revoke all on function public.get_payment_metrics() from public, anon;
grant execute on function public.get_payment_metrics() to authenticated;

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
  reservation.pricing_complete,
  reservation.paid_at,
  reservation.delivered_at,
  reservation.cancelled_at
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
  reservation.pricing_complete,
  reservation.paid_at,
  reservation.delivered_at,
  reservation.cancelled_at;

revoke all on table public.reservation_list from anon, authenticated;
grant select on table public.reservation_list to authenticated;

create index if not exists reservations_reserved_at_idx
  on public.reservations (reserved_at);
create index if not exists reservations_paid_at_idx
  on public.reservations (paid_at) where paid_at is not null;
create index if not exists reservations_delivered_at_idx
  on public.reservations (delivered_at) where delivered_at is not null;
create index if not exists reservations_cancelled_at_idx
  on public.reservations (cancelled_at) where cancelled_at is not null;

comment on table public.reservation_payment_evidence is
  'Normalized private Storage attachments for each reservation payment.';
comment on column public.reservation_payments.evidence_path is
  'Legacy single-evidence path retained for historical compatibility.';

commit;
