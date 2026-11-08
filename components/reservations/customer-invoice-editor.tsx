"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { updateReservationInvoiceItems } from "@/actions/reservations";
import { formatCurrency, formatOrderDateTime } from "@/lib/format";
import type {
  CustomerInvoiceEditor,
  CustomerInvoiceItem,
  ReservationStockOption,
} from "@/types/reservations";

type DraftItem = CustomerInvoiceEditor["items"][number];

export function CustomerInvoiceEditorPanel({
  editor,
  invoiceItems,
  stockItems,
}: {
  editor: CustomerInvoiceEditor;
  invoiceItems: CustomerInvoiceItem[];
  stockItems: ReservationStockOption[];
}) {
  const router = useRouter();
  const [items, setItems] = useState<DraftItem[]>(editor.items);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<{
    status: "success" | "error";
    message: string;
  } | null>(null);

  function updateItem(index: number, update: Partial<DraftItem>) {
    setItems((current) =>
      current.map((item, itemIndex) =>
        itemIndex === index ? { ...item, ...update } : item,
      ),
    );
  }

  function removeItem(itemToRemove: DraftItem) {
    setItems((current) => current.filter((item) => item !== itemToRemove));
  }

  function addItem() {
    const stock = stockItems[0];
    setItems((current) => [
      ...current,
      {
        reservationItemId: "",
        stockItemId: stock?.id ?? "",
        sku: stock?.sku ?? "",
        itemName: stock?.name ?? "",
        category: stock?.category ?? "",
        orderedAt: new Date().toISOString(),
        quantity: 1,
        unitPrice: 0,
        discount: 0,
      },
    ]);
  }

  async function saveItems() {
    if (pending) return;
    setPending(true);
    setFeedback(null);
    const result = await updateReservationInvoiceItems(
      editor.reservationId,
      editor.updatedAt,
      items.map((item) => ({
        reservationItemId: item.reservationItemId || undefined,
        stockItemId: item.stockItemId,
        quantity: item.quantity,
        sellingPrice: item.unitPrice.toFixed(2),
        discount: item.discount.toFixed(2),
        orderedAt: item.orderedAt ?? undefined,
      })),
    );
    setPending(false);
    setFeedback(result);
    if (result.status === "success") router.refresh();
  }

  const draftsById = new Map(
    items
      .filter((item) => item.reservationItemId)
      .map((item) => [item.reservationItemId, item]),
  );
  const existingRows = invoiceItems
    .filter((item) => !draftsById.has(item.id) || draftsById.get(item.id))
    .map((item) => ({
      key: item.id,
      item,
      draft: draftsById.get(item.id),
    }));
  const newRows = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => !item.reservationItemId)
    .map(({ item, index }) => ({
      key: "new-" + index,
      item: {
        id: "new-" + index,
        reservationId: editor.reservationId,
        reservationUpdatedAt: editor.updatedAt,
        stockItemId: item.stockItemId,
        sku: item.sku,
        itemName: item.itemName,
        category: item.category,
        orderedAt: item.orderedAt,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        discount: item.discount,
        lineTotal: Math.max(item.quantity * item.unitPrice - item.discount, 0),
        canShip: false,
        canRecordPayment: false,
        pendingRelease: null,
      } satisfies CustomerInvoiceItem,
      draft: item,
    }));

  return (
    <section className="px-6 py-6 sm:px-8">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[650px] border-collapse text-left">
          <thead>
            <tr className="border-y border-gold/50 bg-gold-soft text-[10px] uppercase tracking-[0.12em] text-gold-dark">
              <th className="px-4 py-3 font-bold">Date</th>
              <th className="px-4 py-3 font-bold">Item</th>
              <th className="px-4 py-3 text-right font-bold">Quantity</th>
              <th className="px-4 py-3 text-right font-bold">Unit Price</th>
              <th className="px-4 py-3 text-right font-bold">Amount</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/80 text-[13px]">
            {[...existingRows, ...newRows].map(({ key, item, draft }) => {
              const displayItem = draft
                ? {
                    ...item,
                    sku: draft.sku,
                    itemName: draft.itemName,
                    category: draft.category,
                    orderedAt: draft.orderedAt,
                    quantity: draft.quantity,
                    unitPrice: draft.unitPrice,
                    discount: draft.discount,
                    lineTotal: Math.max(
                      draft.quantity * draft.unitPrice - draft.discount,
                      0,
                    ),
                  }
                : item;

              return (
                <tr className="even:bg-canvas/35" key={key}>
                  <td className="whitespace-nowrap px-4 py-4 align-top text-xs text-muted">
                    <div className="flex items-center gap-2">
                      {draft && (
                        <button
                          aria-label="Remove item"
                          className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-red-200 text-sm font-bold leading-none text-red-700 hover:bg-red-50"
                          onClick={() => removeItem(draft)}
                          title="Remove item"
                          type="button"
                        >
                          −
                        </button>
                      )}
                      <span>{formatOrderDateTime(displayItem.orderedAt)}</span>
                    </div>
                  </td>
                  <td className="break-words px-4 py-4 align-top font-semibold text-ink">
                    {displayItem.sku + " - " + displayItem.itemName + " - " + displayItem.category}
                  </td>
                  <td className="px-4 py-4 text-right align-top tabular-nums">
                    {displayItem.quantity}
                  </td>
                  <td className="px-4 py-4 text-right align-top tabular-nums">
                    {formatCurrency(displayItem.unitPrice)}
                  </td>
                  <td className="px-4 py-4 text-right align-top font-bold tabular-nums text-ink">
                    {formatCurrency(displayItem.lineTotal)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-8 border-t border-border pt-6" data-print-hide>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-gold-dark">
              Edit reservation items
            </p>
            <p className="mt-1 text-sm text-muted">
              Add items below or use the − button beside an item date to remove it.
            </p>
          </div>
          <button
            className="rounded-lg border border-gold/40 px-3 py-2 text-xs font-bold text-gold-dark hover:bg-gold-soft"
            onClick={addItem}
            type="button"
          >
            + Add item
          </button>
        </div>

        <div className="mt-4 space-y-3">
          {items.length === 0 ? (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-sm text-amber-900">
              Add at least one item before saving this reservation.
            </p>
          ) : (
            items.map((item, index) => (
              <div
                className="grid gap-3 rounded-xl border border-border bg-canvas/40 p-3 md:grid-cols-[minmax(180px,1fr)_110px_130px_auto] md:items-end"
                key={item.reservationItemId || "new-" + index}
              >
                <label className="text-xs font-semibold text-ink">
                  Item
                  <select
                    className="mt-1 h-10 w-full rounded-lg border border-border bg-white px-3 text-sm font-normal outline-none focus:border-gold"
                    onChange={(event) => {
                      const selected = stockItems.find(
                        (stock) => stock.id === event.target.value,
                      );
                      if (!selected) return;
                      updateItem(index, {
                        stockItemId: selected.id,
                        sku: selected.sku,
                        itemName: selected.name,
                        category: selected.category,
                      });
                    }}
                    value={item.stockItemId}
                  >
                    <option value="">Choose item</option>
                    {stockItems.map((stock) => (
                      <option key={stock.id} value={stock.id}>
                        {stock.sku + " - " + stock.name}
                      </option>
                    ))}
                  </select>
                  <span className="mt-1 block text-[11px] font-normal text-muted">
                    {formatOrderDateTime(item.orderedAt)}
                  </span>
                </label>
                <label className="text-xs font-semibold text-ink">
                  Quantity
                  <input
                    className="mt-1 h-10 w-full rounded-lg border border-border bg-white px-3 text-sm font-normal outline-none focus:border-gold"
                    min="1"
                    onChange={(event) =>
                      updateItem(index, {
                        quantity: Math.max(1, Number(event.target.value) || 1),
                      })
                    }
                    type="number"
                    value={item.quantity}
                  />
                </label>
                <label className="text-xs font-semibold text-ink">
                  Unit price
                  <input
                    className="mt-1 h-10 w-full rounded-lg border border-border bg-white px-3 text-sm font-normal outline-none focus:border-gold"
                    min="0"
                    onChange={(event) =>
                      updateItem(index, {
                        unitPrice: Math.max(0, Number(event.target.value) || 0),
                      })
                    }
                    step="0.01"
                    type="number"
                    value={item.unitPrice}
                  />
                </label>
                <div className="flex items-center justify-end">
                  <span className="text-sm font-bold text-ink">
                    {formatCurrency(
                      Math.max(item.quantity * item.unitPrice - item.discount, 0),
                    )}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p
            aria-live="polite"
            className={
              "text-xs " +
              (feedback?.status === "error" ? "text-red-700" : "text-muted")
            }
            role={feedback ? "status" : undefined}
          >
            {feedback?.message ?? "Changes affect the active reservation."}
          </p>
          <button
            className="rounded-lg bg-ink px-4 py-2.5 text-xs font-bold text-white hover:bg-gold-dark disabled:opacity-50"
            disabled={pending || items.length === 0}
            onClick={saveItems}
            type="button"
          >
            {pending ? "Saving..." : "Save items"}
          </button>
        </div>
      </div>
    </section>
  );
}
