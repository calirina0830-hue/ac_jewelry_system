import { formatCurrency, formatOrderDateTime } from "@/lib/format";

import { formatItemLabel } from "@/lib/reservations/item-label";
export type ReservationItemSummary = {
  sku: string;
  itemName: string;
  category: string;
  orderedAt: string | null;
  // Quantity and amount for the current tab (e.g. only the unreleased part
  // in Reserved, only the released part in Delivered).
  quantity: number;
  amount: number;
  pricePending: boolean;
};

/**
 * Every item of a customer's order, listed inside one table row. The three
 * columns (item, qty, amount) use fixed tracks so they line up from one
 * customer row to the next.
 */
export function ReservationItemCell({
  items,
}: {
  items: ReservationItemSummary[];
}) {
  if (!items.length) {
    return <span className="text-sm text-muted">No items</span>;
  }

  return (
    <ul className="divide-y divide-border/70 text-sm">
      {items.map((item, index) => (
        <li
          className="grid grid-cols-[minmax(0,1fr)_2.5rem_6.5rem] items-baseline gap-x-3 py-1.5 first:pt-0 last:pb-0"
          key={item.sku + "-" + index}
        >
          <div className="min-w-0">
            <p className="break-words font-semibold leading-5 text-ink">
              {formatItemLabel({
                sku: item.sku,
                name: item.itemName,
                category: item.category,
              })}
            </p>
            {item.orderedAt && (
              <p className="text-[11px] leading-4 text-muted">
                {formatOrderDateTime(item.orderedAt)}
              </p>
            )}
          </div>
          <span className="text-center tabular-nums text-muted">
            ×{item.quantity}
          </span>
          <span className="text-right tabular-nums text-ink">
            {item.pricePending ? (
              <span className="text-xs font-semibold text-amber-700">
                Price pending
              </span>
            ) : (
              formatCurrency(item.amount)
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}
