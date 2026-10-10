"use client";

import { useState } from "react";

export type ReservationItemSummary = {
  sku: string;
  itemName: string;
  category: string;
};

export function ReservationItemCell({
  items,
}: {
  items: ReservationItemSummary[];
}) {
  const [expanded, setExpanded] = useState(false);
  const first = items[0];
  const rest = items.slice(1);

  if (!first) {
    return <span className="text-sm text-muted">No items</span>;
  }

  return (
    <div className="text-sm">
      <p className="break-words font-semibold text-ink">
        {first.sku + " - " + first.itemName + " - " + first.category}
      </p>
      {rest.length > 0 && !expanded && (
        <button
          aria-expanded={false}
          className="mt-1 block text-xs font-bold text-gold-dark hover:underline"
          onClick={() => setExpanded(true)}
          type="button"
        >
          {"+" + rest.length + " more"}
        </button>
      )}
      {expanded &&
        rest.map((item, index) => (
          <p
            className="mt-1 break-words font-semibold text-ink"
            key={item.sku + "-" + index}
          >
            {item.sku + " - " + item.itemName + " - " + item.category}
          </p>
        ))}
      {rest.length > 0 && expanded && (
        <button
          aria-expanded={true}
          className="mt-1 block text-xs font-bold text-muted hover:text-ink hover:underline"
          onClick={() => setExpanded(false)}
          type="button"
        >
          Show less
        </button>
      )}
    </div>
  );
}
