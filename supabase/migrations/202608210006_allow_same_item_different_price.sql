begin;

-- The legacy schema forbade the same stock item twice in one reservation via
-- reservation_items_one_stock_per_reservation UNIQUE (reservation_id,
-- stock_item_id). Live Selling imports now snapshot the SAME item at
-- DIFFERENT selling prices as SEPARATE lines (price-aware rule introduced in
-- 202608210004/05): the preview accepts them, so confirmation must be able to
-- insert them. With the old constraint still in place the second insert fails
-- with 23505 (duplicate key), which rolls back the whole import even though
-- every row validated - surfacing only as "The import could not be confirmed.
-- No records were created."
--
-- Duplicate protection is enforced where it belongs now:
--   * Import flow: CUSTOMER + ITEM + SELLING PRICE + ACTIVE RESERVED status
--     guard inside confirm_live_order_import (same-price repeats inside one
--     file merge instead of inserting twice).
--   * Manual flow: prepare_reservation_items still rejects repeated stock ids
--     within one reservation payload.
-- The constraint is redundant for those flows and fatal for the new one.
alter table public.reservation_items
  drop constraint if exists reservation_items_one_stock_per_reservation;

commit;
