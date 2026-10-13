"use client";

import { useId, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { createItemRelease } from "@/actions/shipments";
import { formatCurrency, formatOrderDateTime } from "@/lib/format";

export type InvoiceReleaseItem = {
  id: string;
  sku: string;
  itemName: string;
  category: string;
  orderedAt: string | null;
  remainingQty: number;
  originalQty: number;
  unitPrice: number;
  lineTotal: number;
};

export type InvoiceReleaseHistoryItem = {
  id: string;
  shipmentNo: string;
  status: "pending" | "shipped" | "cancelled";
  createdAt: string;
  shippedAt: string | null;
  downpaymentApplied: number;
  notes: string | null;
  items: Array<{
    description: string;
    quantity: number;
  }>;
};

export function InvoiceReleaseModal({
  reservationId,
  reservationNo,
  items,
  availableDownpayment,
  canRelease,
  history,
}: {
  reservationId: string;
  reservationNo: string;
  items: InvoiceReleaseItem[];
  availableDownpayment: number;
  canRelease: boolean;
  history: InvoiceReleaseHistoryItem[];
}) {
  const router = useRouter();
  const dateInputId = useId();
  const downpaymentInputId = useId();
  const notesInputId = useId();

  const [isOpen, setIsOpen] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [selectedItemIds, setSelectedItemIds] = useState<Record<string, boolean>>({});
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  
  // Default release date to today's date formatted as YYYY-MM-DD
  const todayStr = useMemo(() => {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }, []);

  const [releaseDate, setReleaseDate] = useState(todayStr);
  const [downpaymentDeduction, setDownpaymentDeduction] = useState("0");
  const [notes, setNotes] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [lastRelease, setLastRelease] = useState<{
    shipmentId: string;
    shipmentNo: string;
  } | null>(null);

  // Initialize selection & quantities when opening
  const openReleaseModal = () => {
    const initialSelected: Record<string, boolean> = {};
    const initialQty: Record<string, number> = {};
    items.forEach((item) => {
      initialSelected[item.id] = false;
      initialQty[item.id] = item.remainingQty;
    });
    setSelectedItemIds(initialSelected);
    setQuantities(initialQty);
    setReleaseDate(todayStr);
    setDownpaymentDeduction("0");
    setNotes("");
    setErrorMsg(null);
    setLastRelease(null);
    setIsOpen(true);
  };

  const handleToggleItem = (itemId: string) => {
    setSelectedItemIds((prev) => ({
      ...prev,
      [itemId]: !prev[itemId],
    }));
  };

  const handleQuantityChange = (itemId: string, max: number, valueStr: string) => {
    const parsed = parseInt(valueStr, 10);
    const validVal = isNaN(parsed) ? 1 : Math.max(1, Math.min(parsed, max));
    setQuantities((prev) => ({
      ...prev,
      [itemId]: validVal,
    }));
  };

  // Compute selected items summary
  const selectedItemsList = useMemo(() => {
    return items
      .filter((item) => selectedItemIds[item.id])
      .map((item) => {
        const qty = quantities[item.id] ?? item.remainingQty;
        const lineTotal = item.unitPrice * qty;
        return {
          ...item,
          releaseQty: qty,
          releaseLineTotal: lineTotal,
        };
      });
  }, [items, selectedItemIds, quantities]);

  const totalSelectedUnits = useMemo(() => {
    return selectedItemsList.reduce((sum, item) => sum + item.releaseQty, 0);
  }, [selectedItemsList]);

  const totalSelectedValue = useMemo(() => {
    return selectedItemsList.reduce((sum, item) => sum + item.releaseLineTotal, 0);
  }, [selectedItemsList]);

  const numericDownpayment = useMemo(() => {
    const val = parseFloat(downpaymentDeduction);
    return isNaN(val) ? 0 : val;
  }, [downpaymentDeduction]);

  const remainingDownpaymentAfterRelease = Math.max(
    availableDownpayment - numericDownpayment,
    0,
  );

  const handleConfirmRelease = async () => {
    if (selectedItemsList.length === 0) {
      setErrorMsg("Please select at least one item to release.");
      return;
    }
    if (numericDownpayment < 0) {
      setErrorMsg("Downpayment deduction cannot be negative.");
      return;
    }
    if (numericDownpayment > availableDownpayment) {
      setErrorMsg(
        `Downpayment deduction (₱${numericDownpayment.toLocaleString()}) cannot exceed the available downpayment balance (₱${availableDownpayment.toLocaleString()}).`,
      );
      return;
    }
    if (numericDownpayment > totalSelectedValue) {
      setErrorMsg(
        `Downpayment deduction cannot exceed the total value of the released items (${formatCurrency(totalSelectedValue)}).`,
      );
      return;
    }

    setIsSubmitting(true);
    setErrorMsg(null);

    try {
      const payloadItems = selectedItemsList.map((item) => ({
        reservationItemId: item.id,
        quantity: item.releaseQty,
      }));

      const result = await createItemRelease(
        reservationId,
        payloadItems,
        releaseDate,
        downpaymentDeduction,
        notes,
      );

      if (result.status === "error" || !result.shipmentId) {
        setErrorMsg(result.message || "Failed to process item release.");
        setIsSubmitting(false);
        return;
      }

      setLastRelease({
        shipmentId: result.shipmentId,
        shipmentNo: result.shipmentNo ?? "Release",
      });
      router.refresh();
    } catch (err: unknown) {
      console.error(err);
      setErrorMsg("An unexpected error occurred while processing the release.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-2" data-print-hide>
        {canRelease && items.length > 0 && (
          <button
            type="button"
            onClick={openReleaseModal}
            className="inline-flex h-9 items-center rounded-lg border border-gold bg-gold px-3 text-sm font-semibold text-white shadow-sm transition hover:bg-gold-dark"
          >
            Release Items
          </button>
        )}
        {history.length > 0 && (
          <button
            type="button"
            onClick={() => setShowHistory(true)}
            className="inline-flex h-9 items-center rounded-lg border border-border bg-white px-3 text-sm font-semibold text-ink transition hover:border-gold hover:bg-canvas"
          >
            Release History ({history.length})
          </button>
        )}
      </div>

      {/* Item Release Modal */}
      {isOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
        >
          <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-xl border border-border bg-white shadow-2xl">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-border px-6 py-4">
              <div>
                <h2 className="font-serif text-xl font-bold text-ink">
                  Release Items — {reservationNo}
                </h2>
                <p className="text-xs text-muted">
                  Select items and enter release details to hand over to customer.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                disabled={isSubmitting}
                className="rounded-lg p-1 text-muted hover:bg-canvas hover:text-ink"
              >
                ✕
              </button>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
              {lastRelease ? (
                <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-6 text-center space-y-4">
                  <div className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 text-xl font-bold">
                    ✓
                  </div>
                  <div>
                    <h3 className="text-lg font-bold text-emerald-950">
                      Release Confirmed Successfully
                    </h3>
                    <p className="mt-1 text-sm text-emerald-800">
                      Transaction {lastRelease.shipmentNo} has been saved. The invoice preview has been updated to show only remaining items.
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
                    <a
                      href={`/shipments/${lastRelease.shipmentId}/pdf`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex h-10 items-center rounded-lg border border-emerald-600 bg-emerald-600 px-4 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700"
                    >
                      Download Release Receipt (PDF)
                    </a>
                    <button
                      type="button"
                      onClick={() => {
                        setIsOpen(false);
                        setLastRelease(null);
                      }}
                      className="inline-flex h-10 items-center rounded-lg border border-border bg-white px-4 text-sm font-semibold text-ink hover:bg-canvas"
                    >
                      Close
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  {errorMsg && (
                    <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                      {errorMsg}
                    </div>
                  )}

                  {/* Release Date Field */}
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div>
                      <label
                        htmlFor={dateInputId}
                        className="block text-xs font-bold uppercase tracking-wider text-ink"
                      >
                        Release Date <span className="text-red-500">*</span>
                      </label>
                      <input
                        id={dateInputId}
                        type="date"
                        value={releaseDate}
                        onChange={(e) => setReleaseDate(e.target.value)}
                        className="mt-1 block w-full rounded-lg border border-border bg-white px-3 py-2 text-sm text-ink focus:border-gold focus:outline-none"
                      />
                    </div>
                    <div>
                      <label
                        htmlFor={downpaymentInputId}
                        className="block text-xs font-bold uppercase tracking-wider text-ink"
                      >
                        Downpayment Deduction
                      </label>
                      <div className="relative mt-1">
                        <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-sm text-muted">
                          ₱
                        </span>
                        <input
                          id={downpaymentInputId}
                          type="number"
                          step="0.01"
                          min="0"
                          max={availableDownpayment}
                          value={downpaymentDeduction}
                          onChange={(e) => setDownpaymentDeduction(e.target.value)}
                          className="block w-full rounded-lg border border-border bg-white pl-8 pr-3 py-2 text-sm text-ink focus:border-gold focus:outline-none"
                        />
                      </div>
                      <p className="mt-1 text-[11px] text-muted">
                        Available downpayment:{" "}
                        <strong className="text-ink">
                          {formatCurrency(availableDownpayment)}
                        </strong>
                      </p>
                    </div>
                  </div>

                  {/* Item Selection Table */}
                  <div>
                    <label className="block text-xs font-bold uppercase tracking-wider text-ink mb-2">
                      Select Items to Release
                    </label>
                    <div className="border border-border rounded-lg overflow-hidden">
                      <table className="w-full text-left text-sm">
                        <thead className="bg-canvas border-b border-border text-[11px] uppercase tracking-wider text-muted">
                          <tr>
                            <th className="p-3 text-center w-10">Select</th>
                            <th className="p-3">Item Details</th>
                            <th className="p-3">Order Date</th>
                            <th className="p-3 text-right">Available</th>
                            <th className="p-3 text-right w-24">Release Qty</th>
                            <th className="p-3 text-right">Unit Price</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          {items.length === 0 ? (
                            <tr>
                              <td colSpan={6} className="p-4 text-center text-muted">
                                No items available for release.
                              </td>
                            </tr>
                          ) : (
                            items.map((item) => {
                              const isChecked = Boolean(selectedItemIds[item.id]);
                              const qty = quantities[item.id] ?? item.remainingQty;
                              return (
                                <tr
                                  key={item.id}
                                  className={isChecked ? "bg-gold-soft/30" : "hover:bg-canvas/50"}
                                >
                                  <td className="p-3 text-center align-middle">
                                    <input
                                      type="checkbox"
                                      checked={isChecked}
                                      onChange={() => handleToggleItem(item.id)}
                                      className="h-4 w-4 rounded border-border text-gold focus:ring-gold"
                                    />
                                  </td>
                                  <td className="p-3 align-middle font-medium text-ink">
                                    <div>{item.sku} - {item.itemName}</div>
                                    <div className="text-xs text-muted">{item.category}</div>
                                  </td>
                                  <td className="p-3 align-middle text-xs text-muted whitespace-nowrap">
                                    {formatOrderDateTime(item.orderedAt)}
                                  </td>
                                  <td className="p-3 align-middle text-right tabular-nums text-muted">
                                    {item.remainingQty}
                                  </td>
                                  <td className="p-3 align-middle text-right">
                                    <input
                                      type="number"
                                      disabled={!isChecked}
                                      min={1}
                                      max={item.remainingQty}
                                      value={qty}
                                      onChange={(e) =>
                                        handleQuantityChange(
                                          item.id,
                                          item.remainingQty,
                                          e.target.value,
                                        )
                                      }
                                      className="w-20 rounded border border-border px-2 py-1 text-right text-sm text-ink disabled:bg-canvas disabled:text-muted focus:border-gold focus:outline-none"
                                    />
                                  </td>
                                  <td className="p-3 align-middle text-right tabular-nums text-ink">
                                    {formatCurrency(item.unitPrice)}
                                  </td>
                                </tr>
                              );
                            })
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  {/* Notes Field */}
                  <div>
                    <label
                      htmlFor={notesInputId}
                      className="block text-xs font-bold uppercase tracking-wider text-ink"
                    >
                      Release Notes (Optional)
                    </label>
                    <textarea
                      id={notesInputId}
                      rows={2}
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      placeholder="Add courier info, recipient, or other notes..."
                      className="mt-1 block w-full rounded-lg border border-border bg-white px-3 py-2 text-sm text-ink focus:border-gold focus:outline-none"
                    />
                  </div>

                  {/* Release Summary Box */}
                  <div className="rounded-lg border border-gold/40 bg-gold-soft p-4 space-y-1.5 text-sm">
                    <div className="text-xs font-bold uppercase tracking-wider text-gold-dark">
                      Release Summary
                    </div>
                    <div className="flex justify-between text-ink">
                      <span>Selected Items &amp; Units:</span>
                      <span className="font-semibold">{selectedItemsList.length} items ({totalSelectedUnits} units)</span>
                    </div>
                    <div className="flex justify-between text-ink">
                      <span>Total Value of Released Goods:</span>
                      <span className="font-semibold">{formatCurrency(totalSelectedValue)}</span>
                    </div>
                    <div className="flex justify-between text-ink">
                      <span>Downpayment Deducted:</span>
                      <span className="font-semibold text-emerald-700">
                        -{formatCurrency(numericDownpayment)}
                      </span>
                    </div>
                    <div className="flex justify-between text-ink">
                      <span>Remaining Downpayment Balance:</span>
                      <span className="font-semibold">{formatCurrency(remainingDownpaymentAfterRelease)}</span>
                    </div>
                    <div className="border-t border-gold/30 pt-1.5 flex justify-between font-bold text-ink">
                      <span>Balance on Released Items:</span>
                      <span>{formatCurrency(Math.max(totalSelectedValue - numericDownpayment, 0))}</span>
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* Footer */}
            {!lastRelease && (
              <div className="flex items-center justify-end gap-3 border-t border-border px-6 py-4">
                <button
                  type="button"
                  onClick={() => setIsOpen(false)}
                  disabled={isSubmitting}
                  className="rounded-lg border border-border bg-white px-4 py-2 text-sm font-semibold text-ink hover:bg-canvas"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleConfirmRelease}
                  disabled={isSubmitting || selectedItemsList.length === 0}
                  className="rounded-lg border border-gold bg-gold px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-gold-dark disabled:opacity-50"
                >
                  {isSubmitting ? "Processing Release..." : "Confirm Release"}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Release History Modal */}
      {showHistory && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
        >
          <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-xl border border-border bg-white shadow-2xl">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-border px-6 py-4">
              <div>
                <h2 className="font-serif text-xl font-bold text-ink">
                  Release History — {reservationNo}
                </h2>
                <p className="text-xs text-muted">
                  Previous release receipts and item handover records.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowHistory(false)}
                className="rounded-lg p-1 text-muted hover:bg-canvas hover:text-ink"
              >
                ✕
              </button>
            </div>

            {/* History List */}
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
              {history.length === 0 ? (
                <p className="text-center text-sm text-muted py-6">
                  No release records found for this reservation.
                </p>
              ) : (
                history.map((record) => (
                  <div
                    key={record.id}
                    className="rounded-lg border border-border bg-canvas/30 p-4 space-y-3"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-2">
                      <div>
                        <span className="font-semibold text-ink">
                          {record.shipmentNo}
                        </span>
                        <span className="ml-2 rounded-full border border-gold bg-gold-soft px-2 py-0.5 text-[10px] font-bold uppercase text-gold-dark">
                          {record.status}
                        </span>
                      </div>
                      <a
                        href={`/shipments/${record.id}/pdf`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex h-8 items-center rounded-lg border border-border bg-white px-2.5 text-xs font-semibold text-ink hover:border-gold hover:bg-canvas"
                      >
                        Download PDF
                      </a>
                    </div>
                    <div className="text-xs text-muted space-y-1">
                      <div>
                        <strong>Release Date:</strong>{" "}
                        {record.shippedAt
                          ? new Date(record.shippedAt).toLocaleDateString("en-US", {
                              year: "numeric",
                              month: "short",
                              day: "numeric",
                            })
                          : new Date(record.createdAt).toLocaleDateString("en-US", {
                              year: "numeric",
                              month: "short",
                              day: "numeric",
                            })}
                      </div>
                      {record.downpaymentApplied > 0 && (
                        <div>
                          <strong>Downpayment Deducted:</strong>{" "}
                          <span className="text-emerald-700 font-medium">
                            {formatCurrency(record.downpaymentApplied)}
                          </span>
                        </div>
                      )}
                      {record.notes && (
                        <div>
                          <strong>Notes:</strong> {record.notes}
                        </div>
                      )}
                    </div>
                    <div>
                      <div className="text-[11px] font-bold uppercase tracking-wider text-muted mb-1">
                        Released Items
                      </div>
                      <ul className="text-xs text-ink divide-y divide-border/60">
                        {record.items.map((line, idx) => (
                          <li key={idx} className="py-1 flex justify-between">
                            <span>{line.description}</span>
                            <span className="font-medium">{line.quantity} pcs</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end border-t border-border px-6 py-4">
              <button
                type="button"
                onClick={() => setShowHistory(false)}
                className="rounded-lg border border-border bg-white px-4 py-2 text-sm font-semibold text-ink hover:bg-canvas"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
