-- When the customer actually paid, as typed by staff ("Add downpayment" in
-- Edit order). recorded_at stays the moment the payment was entered: it is
-- also the version check used when a payment is edited, so it is never
-- overwritten. Payments without paid_at fall back to recorded_at.

alter table public.reservation_payments
  add column if not exists paid_at timestamptz;

comment on column public.reservation_payments.paid_at is
  'When the customer paid, as entered by staff. Null means use recorded_at.';

create or replace function public.set_reservation_payment_paid_at(
  p_payment_id uuid,
  p_paid_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if auth.uid() is null
     or public.current_profile_role() not in ('admin', 'staff') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_paid_at is null
     or p_paid_at > timezone('utc', now()) + interval '1 day'
     or p_paid_at < timestamptz '2000-01-01' then
    raise exception 'invalid_paid_at' using errcode = 'P0001';
  end if;

  update public.reservation_payments
  set paid_at = p_paid_at
  where id = p_payment_id
    and voided_at is null;

  if not found then
    raise exception 'payment_not_found' using errcode = 'P0001';
  end if;
end;
$function$;

revoke all on function public.set_reservation_payment_paid_at(uuid, timestamptz)
  from public, anon;
grant execute on function public.set_reservation_payment_paid_at(uuid, timestamptz)
  to authenticated;
