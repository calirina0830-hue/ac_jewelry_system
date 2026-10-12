-- Allow a free-form "Other" stock category. The presets stay in the dropdown,
-- but a seller may type a custom category (e.g. Brooch) after choosing "Others".
-- Replace the fixed-value check with a trimmed length check so custom values are
-- accepted while still rejecting empty or oversized categories.
alter table public.stock_items
  drop constraint if exists stock_items_category_valid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'stock_items_category_length'
  ) then
    alter table public.stock_items
      add constraint stock_items_category_length
        check (char_length(btrim(category)) between 1 and 40);
  end if;
end
$$;
