-- Expose each stock item's category so the reservation item header can display
-- SKU, item name, and category while creating or editing a reservation.
-- Changing the RETURNS TABLE shape requires dropping the function first.
drop function if exists public.get_reservable_stock(uuid);

create function public.get_reservable_stock(
  p_exclude_reservation_id uuid default null
)
returns table (
  id uuid,
  sku text,
  name text,
  category text,
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
    stock.category,
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
  'Returns active catalog items with category. Legacy stock quantity and reservation holds do not limit selection.';
