"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import {
  cancelShipment,
  confirmShipment,
  getReleaseFinancialSummary,
  prepareShipment,
} from "@/actions/shipments";
import { formatCurrency, formatManilaDate, formatOrderDateTime } from "@/lib/format";

export type ShippingItem = {
  id: string;
  label: string;
  quantity: number;
  unitPrice: number;
  discount: number;
  orderedAt: string | null;
  shipped: number;
  pending: number;
};

export type ShipmentRow = {
  id: string;
  shipmentNo: string;
  status: "pending" | "shipped" | "cancelled";
  createdAt: string;
  shippedAt: string | null;
  itemCount: number;
  totalQuantity: number;
  downpaymentApplied: number;
  notes: string | null;
  cancelReason: string | null;
};

type Feedback = { status: "success" | "error"; message: string } | null;

type SelectedRow = {
  id: string;
  label: string;
  quantity: number;
  lineTotal: number;
  allocated: number;
  balance: number;
};

type GeneratedRelease = {
  shipmentId: string;
  shipmentNo: string;
  itemCount: number;
  totalQuantity: number;
  downpaymentApplied: number;
  releasedSubtotal: number;
  releasedBalance: number;
  remainingUnapplied: number;
};

const FORMAT_DATE = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
});

export function ShippingPanel({
  reservationId,
  reservationNo,
  downpayment,
  usedDownpayment,
  reservedDownpayment,
  items,
  shipments,
  canWrite,
  canShip,
  isAdmin,
  discount: reservationDiscount = 0,
}: {
  reservationId: string;
  reservationNo: string;
  downpayment: number;
  usedDownpayment: number;
  reservedDownpayment: number;
  items: ShippingItem[];
  shipments: ShipmentRow[];
  canWrite: boolean;
  canShip: boolean;
  isAdmin: boolean;
  discount?: number;
}) {
  const router = useRouter();
  const [selection, setSelection] = useState<Record<string, number>>({});
  const [downpaymentApplied, setDownpaymentApplied] = useState("0");
  const [pending, setPending] = useState(false);
  const [busyShipmentId, setBusyShipmentId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [lastRelease, setLastRelease] = useState<GeneratedRelease | null>(null);
  const [paidAmount, setPaidAmount] = useState(downpayment);
  const [liveUsed, setLiveUsed] = useState(usedDownpayment);
  const [liveReserved, setLiveReserved] = useState(reservedDownpayment);
  const [cancelShipmentId, setCancelShipmentId] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState("");

  const refreshFinances = useCallback(async () => {
    const result = await getReleaseFinancialSummary(reservationId);
    if (result.status === "success") {
      setPaidAmount(result.paidAmount);
      setLiveUsed(result.usedDownpayment);
      setLiveReserved(result.reservedDownpayment);
    }
  }, [reservationId]);

  const reservationDiscountRate = useMemo(
    () => Math.max(Number(reservationDiscount) / 100, 0),
    [reservationDiscount],
  );

  const rows = useMemo(
    () =>
      items.map((item) => {
        const available = Math.max(
          item.quantity - item.shipped - item.pending,
          0,
        );
        const perUnit =
          item.quantity > 0
            ? Math.max(
                (item.unitPrice * item.quantity - item.discount) /
                  item.quantity,
                0,
              )
            : item.unitPrice;
        return {
          ...item,
          available,
          perUnit,
          lineTotal: perUnit * item.quantity,
          releasedTotal: perUnit * available,
        };
      }),
    [items],
  );

  const totalAvailable = rows.reduce(
    (sum, item) => sum + item.available,
    0,
  );
  const totalUnits = rows.reduce((sum, item) => sum + item.quantity, 0);
  const totalValue = rows.reduce((sum, item) => sum + item.lineTotal, 0);

  const selectedItems = useMemo(
    () => rows.filter((item) => (selection[item.id] ?? 0) > 0),
    [rows, selection],
  );

  const releasedValue = useCallback(
    (item: { perUnit: number; quantity: number }) => item.perUnit * item.quantity,
    [],
  );

  const selectedRows: SelectedRow[] = useMemo(
    () =>
      selectedItems.map((item) => ({
        id: item.id,
        label: item.label,
        quantity: selection[item.id],
        lineTotal: releasedValue({
          perUnit: item.perUnit,
          quantity: selection[item.id],
        }),
        allocated: 0,
        balance: 0,
      })),
    [selectedItems, selection, releasedValue],
  );

  const releasedSubtotal = selectedRows.reduce(
    (sum, row) => sum + row.lineTotal,
    0,
  );

  const availableDownpayment = Math.max(
    paidAmount - liveUsed - liveReserved,
    0,
  );

  const downpaymentCap = Math.min(availableDownpayment, releasedSubtotal);

  const previewDownpayment = Math.min(
    Math.max(Number(downpaymentApplied) || 0, 0),
    downpaymentCap,
  );

  const previewLines = useMemo(() => {
    const { lines } = selectedRows.reduce<{
      lines: Array<SelectedRow & { allocated: number; balance: number }>;
      remaining: number;
    }>(
      (acc, row) => {
        const allocated = Math.min(row.lineTotal, acc.remaining);
        const remaining = Math.max(acc.remaining - allocated, 0);
        return {
          remaining,
          lines: [...acc.lines, { ...row, allocated, balance: row.lineTotal - allocated }],
        };
      },
      { lines: [], remaining: previewDownpayment },
    );
    return lines;
  }, [selectedRows, previewDownpayment]);

  const releasedBalance = Math.max(releasedSubtotal - previewDownpayment, 0);
  const remainingAfterRelease = Math.max(
    availableDownpayment - previewDownpayment,
    0,
  );

  function openModal() {
    setSelection({});
    setDownpaymentApplied("0");
    setFeedback(null);
    setLastRelease(null);
    setModalOpen(true);
    void refreshFinances();
  }

  function closeModal() {
    if (pending) return;
    setModalOpen(false);
    setLastRelease(null);
  }

  function toggleItem(reservationItemId: string, max: number) {
    setSelection((current) => {
      const next = { ...current };
      if (next[reservationItemId]) {
        delete next[reservationItemId];
      } else {
        next[reservationItemId] = Math.max(max, 1);
      }
      return next;
    });
  }

  function setItemQuantity(
    reservationItemId: string,
    max: number,
    raw: string,
  ) {
    const parsed = Number.parseInt(raw, 10);
    if (!raw.trim() || Number.isNaN(parsed) || parsed <= 0) {
      setSelection((current) => {
        if (!current[reservationItemId]) return current;
        const next = { ...current };
        delete next[reservationItemId];
        return next;
      });
      return;
    }
    setSelection((current) => ({
      ...current,
      [reservationItemId]: Math.min(Math.max(parsed, 1), Math.max(max, 1)),
    }));
  }

  async function submitRelease() {
    if (pending || selectedItems.length === 0) return;
    setPending(true);
    setFeedback(null);

    const result = await prepareShipment(
      reservationId,
      selectedItems.map((item) => ({
        reservationItemId: item.id,
        quantity: selection[item.id] ?? item.available,
      })),
      downpaymentApplied,
    );

    setPending(false);

    if (result.status === "success") {
      setLastRelease({
        shipmentId: result.shipmentId ?? "",
        shipmentNo: result.shipmentNo ?? "Release prepared",
        itemCount: result.itemCount ?? selectedItems.length,
        totalQuantity:
          result.totalQuantity ??
          selectedItems.reduce((sum, item) => sum + (selection[item.id] ?? 0), 0),
        downpaymentApplied: previewDownpayment,
        releasedSubtotal,
        releasedBalance,
        remainingUnapplied: remainingAfterRelease,
      });
      setFeedback({ status: "success", message: result.message });
      setSelection({});
      setDownpaymentApplied("0");
      void refreshFinances();
      router.refresh();
    } else {
      setFeedback({ status: "error", message: result.message });
    }
  }

  async function handleConfirm(shipmentId: string) {
    if (busyShipmentId) return;
    setBusyShipmentId(shipmentId);
    setFeedback(null);
    const result = await confirmShipment(reservationId, shipmentId);
    setBusyShipmentId(null);
    if (result.status === "success") {
      setFeedback({ status: "success", message: result.message });
      void refreshFinances();
      router.refresh();
    } else {
      setFeedback({ status: "error", message: result.message });
    }
  }

  async function handleCancel(shipmentId: string) {
    if (busyShipmentId) return;
    setBusyShipmentId(shipmentId);
    setFeedback(null);
    const result = await cancelShipment(reservationId, shipmentId, cancelReason);
    setBusyShipmentId(null);
    setCancelShipmentId(null);
    setCancelReason("");
    if (result.status === "success") {
      setFeedback({ status: "success", message: result.message });
      void refreshFinances();
      router.refresh();
    } else {
      setFeedback({ status: "error", message: result.message });
    }
  }

  return (
    <section
      aria-labelledby="release-items-heading"
      className="rounded-3xl border border-border bg-white p-5 shadow-card sm:p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-foreground sm:text-xl">
            Release items
          </h2>
          <p className="mt-1 text-sm text-muted">
            Ship out reserved items to the customer and generate a release
            invoice.
          </p>
        </div>
        {canWrite && canShip && totalAvailable > 0 && (
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={openModal}
              disabled={pending}
              className="inline-flex items-center justify-center rounded-full bg-foreground px-5 py-2.5 text-sm font-semibold text-background transition hover:bg-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
            >
              Release items &amp; generate invoice
            </button>
            <span className="text-sm font-medium text-muted">
              {totalAvailable} unit{totalAvailable === 1 ? "" : "s"} available
            </span>
          </div>
        )}
      </div>

      {canWrite && canShip && totalAvailable === 0 && totalUnits > 0 && (
        <p className="mt-5 rounded-2xl border border-border bg-muted/30 px-4 py-3 text-sm text-muted">
          Every available item on this reservation has been released.
        </p>
      )}

      <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="rounded-2xl border border-border bg-muted/30 p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">
            Total units
          </p>
          <p className="mt-1 text-xl font-semibold text-foreground">
            {totalUnits}
          </p>
        </div>
        <div className="rounded-2xl border border-border bg-muted/30 p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">
            Total value
          </p>
          <p className="mt-1 text-xl font-semibold text-foreground">
            {formatCurrency(totalValue)}
          </p>
        </div>
        <div className="rounded-2xl border border-border bg-muted/30 p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">
            {FORMAT_DATE.format(new Date())}
          </p>
          <p className="mt-1 text-sm font-semibold text-foreground">
            {reservationNo}
          </p>
        </div>
        <div className="rounded-2xl border border-border bg-muted/30 p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">
            Discount
          </p>
          <p className="mt-1 text-xl font-semibold text-foreground">
            {reservationDiscountRate > 0
              ? `${Math.round(reservationDiscountRate * 100)}%`
              : "—"}
          </p>
        </div>
      </div>

      <div className="mt-6">
        <h3 className="text-sm font-semibold text-foreground">Releases</h3>
        {shipments.length === 0 ? (
          <p className="mt-3 rounded-2xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted">
            No items have been released from this reservation yet.
          </p>
        ) : (
          <ul className="mt-3 space-y-3">
            {shipments.map((shipment) => (
              <li
                key={shipment.id}
                className="rounded-2xl border border-border p-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-semibold text-foreground">
                        {shipment.shipmentNo}
                      </p>
                      <span
                        className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${
                          shipment.status === "pending"
                            ? "bg-amber-100 text-amber-900"
                            : shipment.status === "shipped"
                              ? "bg-emerald-100 text-emerald-900"
                              : "bg-muted/40 text-muted-foreground line-through"
                        }`}
                      >
                        {shipment.status}
                      </span>
                      {shipment.downpaymentApplied > 0 && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2.5 py-0.5 text-xs font-medium text-indigo-800">
                          Downpayment applied to this release
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-sm text-muted">
                      {shipment.itemCount} item
                      {shipment.itemCount === 1 ? "" : "s"},{" "}
                      {shipment.totalQuantity} total unit
                      {shipment.totalQuantity === 1 ? "" : "s"} •{" "}
                      {shipment.shippedAt
                        ? "shipped " + formatManilaDate(shipment.shippedAt)
                        : "prepared " + formatManilaDate(shipment.createdAt)}
                    </p>
                    {shipment.notes && (
                      <p className="mt-1 text-xs text-muted">
                        {shipment.notes}
                      </p>
                    )}
                  </div>
                  <div className="text-right">
                    {cancelShipmentId === shipment.id ? (
                      <div className="space-y-2">
                        <p className="text-xs font-semibold text-red-700">
                          {shipment.status === "shipped"
                            ? "Cancel a shipped release? This returns the items to available and frees the applied downpayment."
                            : "Cancel this pending release? This returns the items to available and frees any reserved downpayment."}
                        </p>
                        <input
                          value={cancelReason}
                          onChange={(event) =>
                            setCancelReason(event.target.value)
                          }
                          placeholder="Reason (optional)"
                          maxLength={1000}
                          className="w-full rounded-xl border border-border bg-white px-3 py-2 text-sm text-foreground outline-none transition focus:border-ring focus:ring-2 focus:ring-ring/30 sm:w-64"
                        />
                        <div className="flex justify-end gap-2">
                          <button
                            type="button"
                            disabled={busyShipmentId === shipment.id}
                            onClick={() => {
                              setCancelShipmentId(null);
                              setCancelReason("");
                            }}
                            className="rounded-full border border-border px-3.5 py-2 text-xs font-semibold text-foreground transition hover:bg-muted/40 disabled:opacity-50"
                          >
                            Back
                          </button>
                          <button
                            type="button"
                            disabled={busyShipmentId === shipment.id}
                            onClick={() => void handleCancel(shipment.id)}
                            className="rounded-full bg-red-600 px-3.5 py-2 text-xs font-semibold text-white transition hover:bg-red-700 disabled:opacity-50"
                          >
                            {busyShipmentId === shipment.id
                              ? "Cancelling…"
                              : "Confirm cancel"}
                          </button>
                        </div>
                      </div>
                    ) : shipment.status === "pending" ? (
                      <div className="flex flex-col items-end gap-2">
                        <button
                          type="button"
                          disabled={busyShipmentId === shipment.id}
                          onClick={() => void handleConfirm(shipment.id)}
                          className="inline-flex items-center justify-center rounded-full bg-emerald-600 px-3.5 py-2 text-xs font-semibold text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          Confirm shipped
                        </button>
                        {canWrite && (
                          <button
                            type="button"
                            disabled={busyShipmentId === shipment.id}
                            onClick={() => {
                              setCancelShipmentId(shipment.id);
                              setCancelReason("");
                            }}
                            className="rounded-full border border-border px-3.5 py-2 text-xs font-semibold text-foreground transition hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            Cancel release
                          </button>
                        )}
                      </div>
                    ) : shipment.status === "shipped" ? (
                      <div className="flex flex-col items-end gap-2">
                        <a
                          href={`/shipments/${shipment.id}/pdf`}
                          className="inline-flex items-center justify-center rounded-full border border-border px-3.5 py-2 text-xs font-semibold text-foreground transition hover:bg-muted/40"
                        >
                          View release PDF
                        </a>
                        {isAdmin && (
                          <button
                            type="button"
                            disabled={busyShipmentId === shipment.id}
                            onClick={() => {
                              setCancelShipmentId(shipment.id);
                              setCancelReason("");
                            }}
                            className="rounded-full border border-red-200 bg-red-50 px-3.5 py-2 text-xs font-semibold text-red-700 transition hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            Cancel shipped release
                          </button>
                        )}
                      </div>
                    ) : (
                      <p className="text-xs text-muted">
                        {shipment.cancelReason || "Cancelled"}
                      </p>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {feedback && (
        <div
          className={`mt-5 rounded-2xl border px-4 py-3 text-sm ${
            feedback.status === "success"
              ? "border-emerald-200 bg-emerald-50 text-emerald-900"
              : "border-red-200 bg-red-50 text-red-900"
          }`}
          role="status"
        >
          {feedback.message}
        </div>
      )}

      {modalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 sm:py-10"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeModal();
          }}
        >
          {lastRelease ? (
            <section
              role="dialog"
              aria-modal="true"
              aria-labelledby="release-invoice-generated-title"
              className="w-full max-w-2xl rounded-2xl border border-border bg-white shadow-2xl"
            >
              <div className="flex items-center justify-between gap-4 border-b border-border px-6 py-4">
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-muted">
                    Release invoice generated
                  </p>
                  <h2
                    id="release-invoice-generated-title"
                    className="text-lg font-semibold text-foreground"
                  >
                    Invoice {lastRelease.shipmentNo}
                  </h2>
                </div>
                <button
                  type="button"
                  onClick={closeModal}
                  className="rounded-full p-2 text-muted-foreground transition hover:bg-muted/40"
                  aria-label="Close"
                >
                  ×
                </button>
              </div>
              <div className="px-6 py-5">
                <p className="text-sm text-muted">
                  This release reserved{" "}
                  <strong className="text-foreground">
                    {lastRelease.itemCount} item
                    {lastRelease.itemCount === 1 ? "" : "s"}
                  </strong>{" "}
                  ({lastRelease.totalQuantity} unit
                  {lastRelease.totalQuantity === 1 ? "" : "s"}) out for
                  shipment. Only the released items are invoiced; unreleased
                  items remain on hold.
                </p>
                <dl className="mt-5 space-y-2 rounded-2xl border border-border bg-muted/20 p-4 text-sm">
                  <div className="flex items-center justify-between">
                    <dt className="text-muted">Released items subtotal</dt>
                    <dd className="font-semibold text-foreground">
                      {formatCurrency(lastRelease.releasedSubtotal)}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between">
                    <dt className="text-muted">Downpayment applied</dt>
                    <dd className="font-semibold text-foreground">
                      − {formatCurrency(lastRelease.downpaymentApplied)}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between border-t border-border pt-2">
                    <dt className="font-semibold text-foreground">
                      Balance on released goods
                    </dt>
                    <dd className="text-base font-bold text-foreground">
                      {formatCurrency(lastRelease.releasedBalance)}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between text-xs">
                    <dt className="text-muted">
                      Unapplied downpayment remaining after this release
                    </dt>
                    <dd className="font-medium text-muted-foreground">
                      {formatCurrency(lastRelease.remainingUnapplied)}
                    </dd>
                  </div>
                </dl>
                <div className="mt-6 flex flex-wrap justify-end gap-3">
                  <button
                    type="button"
                    onClick={closeModal}
                    className="inline-flex items-center justify-center rounded-full border border-border px-5 py-2.5 text-sm font-semibold text-foreground transition hover:bg-muted/40"
                  >
                    Done
                  </button>
                  {lastRelease.shipmentId && (
                    <a
                      href={`/shipments/${lastRelease.shipmentId}/pdf`}
                      className="inline-flex items-center justify-center rounded-full bg-foreground px-5 py-2.5 text-sm font-semibold text-background transition hover:bg-muted-foreground"
                    >
                      Open release PDF
                    </a>
                  )}
                </div>
              </div>
            </section>
          ) : (
            <section
              role="dialog"
              aria-modal="true"
              aria-labelledby="release-invoice-modal-title"
              className="w-full max-w-3xl rounded-2xl border border-border bg-white shadow-2xl"
            >
              <div className="flex items-center justify-between gap-4 border-b border-border px-6 py-4">
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-muted">
                    {reservationNo}
                  </p>
                  <h2
                    id="release-invoice-modal-title"
                    className="text-lg font-semibold text-foreground"
                  >
                    Release items &amp; generate invoice
                  </h2>
                </div>
                <button
                  type="button"
                  onClick={closeModal}
                  disabled={pending}
                  className="rounded-full p-2 text-muted-foreground transition hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-50"
                  aria-label="Close"
                >
                  ×
                </button>
              </div>

              <div className="grid grid-cols-2 gap-3 border-b border-border bg-muted/20 px-6 py-4 sm:grid-cols-4">
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-muted">
                    Downpayment available
                  </p>
                  <p className="mt-0.5 text-lg font-semibold text-foreground">
                    {formatCurrency(paidAmount)}
                  </p>
                </div>
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-muted">
                    Used on shipped releases
                  </p>
                  <p className="mt-0.5 text-lg font-semibold text-foreground">
                    {formatCurrency(liveUsed)}
                  </p>
                </div>
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-muted">
                    Reserved by open release
                  </p>
                  <p className="mt-0.5 text-lg font-semibold text-foreground">
                    {formatCurrency(liveReserved)}
                  </p>
                </div>
                <div>
                  <p className="text-xs font-medium uppercase tracking-wide text-muted">
                    Remaining unapplied
                  </p>
                  <p className="mt-0.5 text-lg font-semibold text-foreground">
                    {formatCurrency(
                      Math.max(paidAmount - liveUsed - liveReserved, 0),
                    )}
                  </p>
                </div>
              </div>

              <div className="px-6 py-4">
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-border text-sm">
                    <thead>
                      <tr>
                        <th className="w-10 pr-3" />
                        <th className="py-2 text-left text-xs font-medium uppercase tracking-wide text-muted">
                          Item
                        </th>
                        <th className="py-2 text-left text-xs font-medium uppercase tracking-wide text-muted">
                          Order date
                        </th>
                        <th className="py-2 text-right text-xs font-medium uppercase tracking-wide text-muted">
                          Qty
                        </th>
                        <th className="py-2 text-right text-xs font-medium uppercase tracking-wide text-muted">
                          Unit price
                        </th>
                        <th className="py-2 text-right text-xs font-medium uppercase tracking-wide text-muted">
                          Line total
                        </th>
                        <th className="py-2 text-right text-xs font-medium uppercase tracking-wide text-muted">
                          Select
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {rows.map((item) => {
                        const selectedQuantity =
                          selection[item.id] ?? 0;
                        const selected = selectedQuantity > 0;
                        const canSelect = item.available > 0;
                        return (
                          <tr
                            key={item.id}
                            className={
                              selected
                                ? "bg-indigo-50/40"
                                : "transition hover:bg-muted/20"
                            }
                          >
                            <td className="py-2.5 pr-3 text-center">
                              <input
                                type="checkbox"
                                disabled={!canSelect}
                                checked={selected}
                                onChange={() =>
                                  toggleItem(item.id, item.available)
                                }
                                aria-label={`Select ${item.label}`}
                                className="h-4 w-4 rounded border-border"
                              />
                            </td>
                            <td className="py-2.5">
                              <p className="font-medium text-foreground">
                                {item.label}
                              </p>
                              {item.shipped + item.pending > 0 && (
                                <p className="text-xs text-muted">
                                  {item.shipped} shipped, {item.pending} in an
                                  open release
                                </p>
                              )}
                            </td>
                            <td className="whitespace-nowrap py-2.5 pr-3 text-sm text-muted-foreground">
                              {formatOrderDateTime(item.orderedAt)}
                            </td>
                            <td className="py-2.5 text-right text-muted-foreground">
                              {item.quantity}
                            </td>
                            <td className="py-2.5 text-right font-medium text-foreground">
                              {formatCurrency(item.perUnit)}
                            </td>
                            <td className="py-2.5 text-right text-muted-foreground">
                              {formatCurrency(item.lineTotal)}
                            </td>
                            <td className="py-2.5 text-right">
                              {selected ? (
                                <div className="flex items-center justify-end gap-2">
                                  <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                    <span className="sr-only">
                                      Quantity to release
                                    </span>
                                    <input
                                      type="number"
                                      min={1}
                                      max={item.available}
                                      value={selectedQuantity}
                                      onChange={(event) =>
                                        setItemQuantity(
                                          item.id,
                                          item.available,
                                          event.target.value,
                                        )
                                      }
                                      className="w-16 rounded-lg border border-border bg-white py-1 text-center text-sm text-foreground outline-none transition focus:border-ring focus:ring-2 focus:ring-ring/30"
                                    />
                                    <span>/ {item.available}</span>
                                  </label>
                                  <button
                                    type="button"
                                    onClick={() =>
                                      toggleItem(item.id, item.available)
                                    }
                                    className="rounded-full px-2.5 py-1 text-xs font-semibold text-indigo-600 transition hover:bg-indigo-50"
                                  >
                                    Remove
                                  </button>
                                </div>
                              ) : (
                                <button
                                  type="button"
                                  disabled={!canSelect}
                                  onClick={() =>
                                    toggleItem(item.id, item.available)
                                  }
                                  className={`rounded-full px-2.5 py-1 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 ${
                                    "border border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100"
                                  }`}
                                >
                                  {item.available === 0
                                    ? "None left"
                                    : "Select"}
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {selectedRows.length > 0 && (
                  <div className="mt-4 rounded-2xl border border-indigo-100 bg-indigo-50/40 px-4 py-3 text-sm">
                    <p>
                      <strong className="text-foreground">
                        {selectedRows.length}
                      </strong>{" "}
                      item{selectedRows.length === 1 ? "" : "s"} selected worth{" "}
                      <strong className="text-foreground">
                        {formatCurrency(releasedSubtotal)}
                      </strong>
                    </p>
                    <p className="mt-1 text-xs text-muted">
                      At most{" "}
                      <strong className="text-foreground">
                        {formatCurrency(downpaymentCap)}
                      </strong>{" "}
                      of downpayment can be applied to this release.
                    </p>
                  </div>
                )}

                <div className="mt-4">
                  <label
                    htmlFor="release-downpayment"
                    className="text-sm font-medium text-foreground"
                  >
                    Downpayment to apply to this release
                  </label>
                  <div className="mt-2 flex flex-wrap items-center gap-3">
                    <input
                      id="release-downpayment"
                      type="number"
                      value={downpaymentApplied}
                      onChange={(event) =>
                        setDownpaymentApplied(event.target.value)
                      }
                      min={0}
                      step={1}
                      disabled={selectedRows.length === 0}
                      className="w-44 rounded-xl border border-border bg-white px-3.5 py-2.5 text-sm text-foreground outline-none transition focus:border-ring focus:ring-2 focus:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50"
                      placeholder="0"
                    />
                    <p className="text-xs text-muted">
                      Cannot exceed {formatCurrency(downpaymentCap)} (whichever
                      is lower: remaining unapplied downpayment or the released
                      items&#39; subtotal).
                    </p>
                  </div>
                </div>
              </div>

              {selectedRows.length > 0 && (
                <div className="border-t border-border px-6 py-4">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold text-foreground">
                      Invoice preview
                    </h3>
                    <span className="text-xs text-muted">
                      Only the items below are invoiced for this release.
                    </span>
                  </div>
                  <div className="mt-3 overflow-x-auto">
                    <table className="min-w-full divide-y divide-border text-sm">
                      <thead>
                        <tr>
                          <th className="py-2 text-left text-xs font-medium uppercase tracking-wide text-muted">
                            Item
                          </th>
                          <th className="py-2 text-right text-xs font-medium uppercase tracking-wide text-muted">
                            Qty
                          </th>
                          <th className="py-2 text-right text-xs font-medium uppercase tracking-wide text-muted">
                            Subtotal
                          </th>
                          <th className="py-2 text-right text-xs font-medium uppercase tracking-wide text-muted">
                            Downpayment deducted
                          </th>
                          <th className="py-2 text-right text-xs font-medium uppercase tracking-wide text-muted">
                            Balance
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {previewLines.map((line) => (
                          <tr key={line.id}>
                            <td className="py-2.5 font-medium text-foreground">
                              {line.label}
                            </td>
                            <td className="py-2.5 text-right text-muted-foreground">
                              {line.quantity}
                            </td>
                            <td className="py-2.5 text-right font-medium text-foreground">
                              {formatCurrency(line.lineTotal)}
                            </td>
                            <td className="py-2.5 text-right text-muted-foreground">
                              − {formatCurrency(line.allocated)}
                            </td>
                            <td className="py-2.5 text-right font-semibold text-foreground">
                              {formatCurrency(line.balance)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <dl className="mt-4 ml-auto w-full max-w-sm space-y-1.5 text-sm">
                    <div className="flex items-center justify-between">
                      <dt className="text-muted">Released items subtotal</dt>
                      <dd className="font-semibold text-foreground">
                        {formatCurrency(releasedSubtotal)}
                      </dd>
                    </div>
                    <div className="flex items-center justify-between">
                      <dt className="text-muted">Downpayment applied</dt>
                      <dd className="font-semibold text-foreground">
                        − {formatCurrency(previewDownpayment)}
                      </dd>
                    </div>
                    <div className="flex items-center justify-between border-t border-border pt-2">
                      <dt className="font-semibold text-foreground">
                        Balance on released goods
                      </dt>
                      <dd className="text-base font-bold text-foreground">
                        {formatCurrency(releasedBalance)}
                      </dd>
                    </div>
                    <div className="flex items-center justify-between text-xs">
                      <dt className="text-muted">
                        Remaining unapplied downpayment after this release
                      </dt>
                      <dd className="font-medium text-muted-foreground">
                        {formatCurrency(remainingAfterRelease)}
                      </dd>
                    </div>
                  </dl>
                </div>
              )}

              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-6 py-4">
                <button
                  type="button"
                  onClick={closeModal}
                  disabled={pending}
                  className="rounded-full border border-border px-5 py-2.5 text-sm font-semibold text-foreground transition hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void submitRelease()}
                  disabled={pending || selectedRows.length === 0}
                  className="inline-flex items-center justify-center rounded-full bg-foreground px-5 py-2.5 text-sm font-semibold text-background transition hover:bg-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {pending
                    ? "Creating release…"
                    : "Create release & generate invoice"}
                </button>
              </div>
            </section>
          )}
        </div>
      )}
    </section>
  );
}