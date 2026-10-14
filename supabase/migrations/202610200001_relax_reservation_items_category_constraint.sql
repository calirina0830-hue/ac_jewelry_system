-- Migration: 202610200001_relax_reservation_items_category_constraint.sql
-- Description: Relax reservation_items.category check constraint to allow custom categories,
-- matching the update previously made to stock_items (202610140001_stock_custom_category.sql).

alter table public.reservation_items
  drop constraint if exists reservation_items_category_valid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'reservation_items_category_length'
  ) then
    alter table public.reservation_items
      add constraint reservation_items_category_length
        check (char_length(btrim(category)) between 1 and 40);
  end if;
end
$$;
