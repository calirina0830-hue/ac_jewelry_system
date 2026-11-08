"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { moveReservations } from "@/actions/reservations";
import { cancelShipment, confirmShipment, createItemRelease } from "@/actions/shipments";
import { BUSINESS } from "@/lib/constants/business";
import { formatCurrency, formatDate, formatOrderDateTime } from "@/lib/format";
import type { CustomerInvoice } from "@/lib/reservations/customer-invoice";
import { formatItemLabel } from "@/lib/reservations/item-label";
import { selectCustomerInvoiceItems } from "@/lib/reservations/customer-invoice-selection";
import { buildBulkPaymentHref } from "@/lib/reservations/payment-selection";
import { canRoleTransitionReservation } from "@/lib/reservations/status";
import type { ProfileRole } from "@/types/database";

type ActionMessage = { status: "success" | "error"; message: string };
type Confirmable = "release" | "delivered" | "cancelled";

// Today's local date as YYYY-MM-DD, the release form's default.
function todayInputValue() {
  const now = new Date();
  return (
    now.getFullYear() +
    "-" +
    String(now.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(now.getDate()).padStart(2, "0")
  );
}

const CONFIRM_TEXT: Record<Confirmable, (count: number) => string> = {
  release: (count) => "Release " + count + " item" + (count === 1 ? "" : "s") + " now?",
  delivered: (count) =>
    "Mark this order as delivered?" + (count > 1 ? " (" + count + " reservations)" : ""),
  cancelled: (count) =>
    "Cancel this order? Its items go back to stock." +
    (count > 1 ? " (" + count + " reservations)" : ""),
};

const STATUS_TONE = {
  amber: "bg-amber-50 text-amber-800",
  sky: "bg-sky-50 text-sky-700",
  emerald: "bg-emerald-50 text-emerald-700",
  red: "bg-red-50 text-red-700",
  stone: "bg-stone-100 text-stone-700",
} as const;

function describeOrderStatus(invoice: CustomerInvoice): {
  label: string;
  tone: keyof typeof STATUS_TONE;
} {
  const statuses = new Set(invoice.reservations.map((r) => r.status));
  if (statuses.size !== 1) return { label: "Mixed status", tone: "stone" };
  const [status] = statuses;
  if (status === "reserved") {
    return invoice.totals.amountPaid > 0 && invoice.totals.balance > 0
      ? { label: "Partially paid", tone: "sky" }
      : { label: "Reserved", tone: "amber" };
  }
  if (status === "paid") return { label: "Paid", tone: "emerald" };
  if (status === "delivered") return { label: "Delivered", tone: "sky" };
  return { label: "Cancelled", tone: "red" };
}

const primaryButton =
  "inline-flex h-10 items-center rounded-xl bg-ink px-4 text-sm font-bold text-white transition hover:bg-gold-dark disabled:cursor-not-allowed disabled:opacity-50";
const secondaryButton =
  "inline-flex h-10 items-center rounded-xl border border-border bg-white px-4 text-sm font-semibold text-ink transition hover:border-gold hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-50";

/**
 * Customer order panel: the live invoice plus every everyday action for that
 * customer, so nothing needs another page or tab.
 *
 * Each item has one checkbox ("include"). All items start included; the
 * included items are what Print, PDF and Release act on. Unticking an item
 * only leaves it out here; reservation records are unchanged.
 */
export function CustomerInvoicePreview({
  invoice,
  closeHref,
  canWrite,
  downloadHref,
  printHref,
  orderActions,
  role,
  editBaseHref,
}: {
  invoice: CustomerInvoice;
  closeHref: string;
  canWrite: boolean;
  downloadHref: string;
  printHref: string;
  // Rare per-reservation actions (revert, archive, restore, delete).
  orderActions?: ReactNode;
  role: ProfileRole | undefined;
  // This view's URL; the edit window opens on top of it.
  editBaseHref: string;
}) {
  const router = useRouter();
  const invoiceRef = useRef<HTMLElement>(null);
  const [invoiceScale, setInvoiceScale] = useState(1);
  const [excludedIds, setExcludedIds] = useState<string[]>([]);
  const [confirming, setConfirming] = useState<Confirmable | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<ActionMessage | null>(null);
  const [releaseDate, setReleaseDate] = useState(todayInputValue);
  const [releaseDownpayments, setReleaseDownpayments] = useState<Record<string, string>>({});
  const [releaseError, setReleaseError] = useState<string | null>(null);

  const includedIds = invoice.items
    .filter((item) => !excludedIds.includes(item.id))
    .map((item) => item.id);
  const displayInvoice = excludedIds.length
    ? selectCustomerInvoiceItems(invoice, includedIds)
    : invoice;
  const itemsQuery = excludedIds.length
    ? "&items=" + encodeURIComponent(includedIds.join(","))
    : "";
  const releasableItems = displayInvoice.items.filter((item) => item.canShip);
  // One release per reservation; each needs its own downpayment amount.
  const releaseGroups = [...new Set(releasableItems.map((item) => item.reservationId))].map(
    (reservationId) => {
      const items = releasableItems.filter((item) => item.reservationId === reservationId);
      return {
        reservationId,
        items,
        value: items.reduce((sum, item) => sum + item.lineTotal, 0),
      };
    },
  );
  const payableReservationIds = [
    ...new Set(
      invoice.items
        .filter((item) => item.canRecordPayment)
        .map((item) => item.reservationId),
    ),
  ];
  const allIncluded = excludedIds.length === 0;
  // One Edit; several orders are switched inside the edit window.
  const editTarget =
    invoice.editableReservations.find((reservation) => reservation.needsPricing) ??
    invoice.editableReservations[0];
  // Reservations that this user may move to each status. The server checks
  // the same rules again before changing anything.
  const movable = {
    delivered: invoice.reservations.filter(
      (r) => !r.archived && canRoleTransitionReservation(role, r.status, "delivered"),
    ),
    cancelled: invoice.reservations.filter(
      (r) => !r.archived && canRoleTransitionReservation(role, r.status, "cancelled"),
    ),
  };
  const orderStatus = describeOrderStatus(invoice);
  const confirmCount =
    confirming === "release"
      ? releasableItems.length
      : confirming
        ? movable[confirming].length
        : 0;

  function askToConfirm(action: Confirmable) {
    setConfirming(action);
    setMessage(null);
  }

  async function moveOrder(to: "delivered" | "cancelled") {
    if (busy || movable[to].length === 0) return;
    setBusy(true);
    setMessage(null);
    const result = await moveReservations(
      movable[to].map((r) => ({ id: r.id, updatedAt: r.updatedAt })),
      to,
    );
    return finish(result);
  }

  function close() {
    router.push(closeHref, { scroll: false });
  }

  function toggleItem(itemId: string) {
    setExcludedIds((current) =>
      current.includes(itemId)
        ? current.filter((id) => id !== itemId)
        : [...current, itemId],
    );
    setConfirming(null);
    setMessage(null);
  }

  function toggleAll() {
    setExcludedIds(allIncluded ? invoice.items.map((item) => item.id) : []);
    setConfirming(null);
    setMessage(null);
  }

  async function finish(result: ActionMessage) {
    setBusy(false);
    setConfirming(null);
    setMessage(result);
    router.refresh();
  }

  // Uses the same release rules as the release form on the reservation page:
  // each release records the downpayment received for that handover
  // (more than ₱0, at most the released items' value); the rest is COD.
  async function releaseIncluded() {
    if (busy || releaseGroups.length === 0) return;

    for (const group of releaseGroups) {
      const amount = Number(releaseDownpayments[group.reservationId] ?? "");
      if (!Number.isFinite(amount) || amount <= 0) {
        setReleaseError(
          "Enter the downpayment received" +
            (releaseGroups.length > 1 ? " for order " + (releaseGroups.indexOf(group) + 1) : "") +
            ". It must be more than ₱0.00.",
        );
        return;
      }
      if (amount > group.value + 0.005) {
        setReleaseError(
          "The downpayment cannot be more than the released items' value (" +
            formatCurrency(group.value) +
            ").",
        );
        return;
      }
    }
    if (!releaseDate) {
      setReleaseError("Enter the release date.");
      return;
    }

    setBusy(true);
    setMessage(null);
    setReleaseError(null);
    for (const group of releaseGroups) {
      const result = await createItemRelease(
        group.reservationId,
        group.items.map((item) => ({ reservationItemId: item.id, quantity: item.quantity })),
        releaseDate,
        releaseDownpayments[group.reservationId],
      );
      if (result.status !== "success") {
        return finish({ status: "error", message: result.message });
      }
    }
    setExcludedIds([]);
    setReleaseDownpayments({});
    return finish({
      status: "success",
      message:
        releasableItems.length +
        " item" +
        (releasableItems.length === 1 ? " was" : "s were") +
        " released.",
    });
  }

  async function resolvePendingRelease(
    reservationId: string,
    shipmentId: string,
    mode: "confirm" | "undo",
  ) {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    const result =
      mode === "confirm"
        ? await confirmShipment(reservationId, shipmentId)
        : await cancelShipment(
            reservationId,
            shipmentId,
            "Cancelled from the customer invoice.",
          );
    return finish({
      status: result.status === "success" ? "success" : "error",
      message:
        result.status === "success"
          ? mode === "confirm"
            ? "Pending release confirmed."
            : "Pending release undone. The items are back on this invoice."
          : result.message,
    });
  }

  const customerDetails = [
    ["Facebook / CS Name", invoice.facebookName],
    ["Phone", invoice.phone],
    ["Address", invoice.address],
  ].filter((detail): detail is [string, string] => Boolean(detail[1]));

  // Close with Escape.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") router.push(closeHref, { scroll: false });
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeHref, router]);

  useEffect(() => {
    function fitInvoice() {
      const invoiceElement = invoiceRef.current;
      if (!invoiceElement) return;

      const availableHeight = Math.max(window.innerHeight - 32, 320);
      const availableWidth = Math.max(window.innerWidth - 32, 320);
      const scale = Math.min(
        1,
        availableHeight / invoiceElement.scrollHeight,
        availableWidth / invoiceElement.offsetWidth,
      );

      setInvoiceScale(Number.isFinite(scale) && scale > 0 ? scale : 1);
    }

    const frame = window.requestAnimationFrame(fitInvoice);
    window.addEventListener("resize", fitInvoice);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", fitInvoice);
    };
  }, [
    displayInvoice.items.length,
    displayInvoice.totals.total,
    invoice.customerName,
    invoice.pendingReleases.length,
    message,
    confirming,
  ]);

  return (
    <div
      aria-label={"Invoice for " + invoice.customerName}
      aria-modal="true"
      className="fixed inset-0 z-50 flex min-h-screen items-center justify-center overflow-hidden bg-ink/40 px-4 py-4 sm:px-6"
      data-print-modal
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
      role="dialog"
    >
      <div
        className="mx-auto w-full max-w-3xl"
        style={{
          transform: "scale(" + invoiceScale + ")",
          transformOrigin: "center center",
        }}
      >
        <article
          className="relative overflow-hidden rounded-3xl border border-border bg-white shadow-card"
          data-print-root
          ref={invoiceRef}
        >
          {/* Action bar: everything for this customer in one place. */}
          <div
            className="flex flex-wrap items-center gap-2 border-b border-border bg-canvas/60 px-5 py-3 sm:px-6"
            data-print-hide
          >
            <span
              className={
                "rounded-full px-2.5 py-1 text-xs font-bold uppercase tracking-wide " +
                STATUS_TONE[orderStatus.tone]
              }
              title="Current status of this customer's order"
            >
              {orderStatus.label}
            </span>
            {confirming ? (
              <span className="inline-flex flex-wrap items-center gap-2 rounded-xl border border-gold/60 bg-gold-soft px-2 py-1">
                <span className="px-1 text-sm font-semibold text-ink">
                  {CONFIRM_TEXT[confirming](confirmCount)}
                </span>
                <button
                  className={
                    (confirming === "cancelled"
                      ? "bg-red-700 hover:bg-red-800"
                      : "bg-ink hover:bg-gold-dark") +
                    " inline-flex h-8 items-center rounded-lg px-3 text-sm font-bold text-white transition disabled:opacity-50"
                  }
                  disabled={busy}
                  onClick={() =>
                    void (confirming === "release"
                      ? releaseIncluded()
                      : moveOrder(confirming))
                  }
                  type="button"
                >
                  {busy ? "Working…" : "Yes"}
                </button>
                <button
                  className="h-8 rounded-lg px-2 text-sm font-semibold text-muted hover:text-ink"
                  disabled={busy}
                  onClick={() => setConfirming(null)}
                  type="button"
                >
                  No
                </button>
              </span>
            ) : (
              canWrite && (
                <>
                  {releasableItems.length > 0 && (
                    <button
                      className={primaryButton}
                      disabled={busy}
                      onClick={() => askToConfirm("release")}
                      title="Mark the ticked items as released to the customer"
                      type="button"
                    >
                      Release {allIncluded ? "all" : releasableItems.length} item
                      {releasableItems.length === 1 ? "" : "s"}
                    </button>
                  )}
                  {payableReservationIds.length > 0 && (
                    <Link
                      className="inline-flex h-10 items-center rounded-xl bg-emerald-700 px-4 text-sm font-bold text-white transition hover:bg-emerald-800"
                      href={buildBulkPaymentHref(payableReservationIds)}
                      title="Opens the payment form with the full balance filled in. Paying it in full moves the order to Paid."
                    >
                      Mark as paid
                    </Link>
                  )}
                  {movable.delivered.length > 0 && (
                    <button
                      className={secondaryButton}
                      disabled={busy}
                      onClick={() => askToConfirm("delivered")}
                      type="button"
                    >
                      Mark delivered
                    </button>
                  )}
                  {movable.cancelled.length > 0 && (
                    <button
                      className={secondaryButton + " text-red-700 hover:border-red-300"}
                      disabled={busy}
                      onClick={() => askToConfirm("cancelled")}
                      type="button"
                    >
                      Cancel order
                    </button>
                  )}
                </>
              )
            )}
            {canWrite &&
              editTarget && (
                <Link
                  className={secondaryButton}
                  href={editBaseHref + "&editOrder=" + editTarget.id}
                  scroll={false}
                >
                  Edit
                </Link>
              )}
            <span className="ml-auto flex items-center gap-2">
              <a
                className={secondaryButton}
                href={printHref + itemsQuery}
                rel="noreferrer"
                target="_blank"
              >
                Print
              </a>
              <a
                className={secondaryButton}
                download
                href={downloadHref + itemsQuery}
              >
                PDF
              </a>
              <Link
                aria-label="Close invoice (Esc)"
                className="inline-flex h-10 w-10 items-center justify-center rounded-full text-xl leading-none text-muted transition hover:bg-white hover:text-ink"
                href={closeHref}
                scroll={false}
                title="Close (Esc)"
              >
                ×
              </Link>
            </span>
            {confirming === "release" && (
              <div className="grid w-full gap-3 rounded-xl border border-gold/60 bg-white p-3 sm:grid-cols-[1fr_auto]">
                <div className="space-y-2">
                  {releaseGroups.map((group) => {
                    const entered = Number(releaseDownpayments[group.reservationId] ?? "");
                    const cod = Math.max(
                      group.value - (Number.isFinite(entered) ? entered : 0),
                      0,
                    );
                    return (
                      <label
                        className="flex flex-wrap items-center gap-2 text-sm"
                        key={group.reservationId}
                      >
                        <span className="min-w-40 font-semibold text-ink">
                          Downpayment received
                          {releaseGroups.length > 1 ? " · Order " + (releaseGroups.indexOf(group) + 1) : ""}
                        </span>
                        <span className="inline-flex items-center rounded-lg border border-border px-2 focus-within:border-gold">
                          <span className="text-muted">₱</span>
                          <input
                            autoFocus={group === releaseGroups[0]}
                            className="h-9 w-28 bg-transparent px-1 text-right tabular-nums outline-none"
                            inputMode="decimal"
                            min="0"
                            onChange={(event) => {
                              setReleaseError(null);
                              setReleaseDownpayments((current) => ({
                                ...current,
                                [group.reservationId]: event.target.value,
                              }));
                            }}
                            placeholder="0.00"
                            step="0.01"
                            type="number"
                            value={releaseDownpayments[group.reservationId] ?? ""}
                          />
                        </span>
                        <span className="text-xs text-muted">
                          of {formatCurrency(group.value)} · COD on delivery:{" "}
                          <strong className="text-ink">{formatCurrency(cod)}</strong>
                        </span>
                      </label>
                    );
                  })}
                </div>
                <label className="flex items-center gap-2 text-sm sm:flex-col sm:items-start sm:gap-1">
                  <span className="font-semibold text-ink">Release date</span>
                  <input
                    className="h-9 rounded-lg border border-border bg-transparent px-2 outline-none focus:border-gold"
                    onChange={(event) => setReleaseDate(event.target.value)}
                    type="date"
                    value={releaseDate}
                  />
                </label>
                {releaseError && (
                  <p className="text-sm font-semibold text-red-700 sm:col-span-2" role="alert">
                    {releaseError}
                  </p>
                )}
              </div>
            )}
            {message && (
              <p
                className={
                  "w-full text-sm font-semibold " +
                  (message.status === "error" ? "text-red-700" : "text-emerald-700")
                }
                role="status"
              >
                {message.message}
              </p>
            )}
            {canWrite &&
              invoice.pendingReleases.map((release) => (
                <div
                  className="flex w-full flex-wrap items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
                  key={release.shipmentId}
                >
                  <span className="mr-auto">
                    <strong>Release not finished:</strong>{" "}
                    {release.itemLabels.join(", ")}
                  </span>
                  <button
                    className="h-8 rounded-lg bg-ink px-3 text-xs font-bold text-white hover:bg-gold-dark disabled:opacity-50"
                    disabled={busy}
                    onClick={() =>
                      void resolvePendingRelease(release.reservationId, release.shipmentId, "confirm")
                    }
                    type="button"
                  >
                    Confirm release
                  </button>
                  <button
                    className="h-8 rounded-lg px-2 text-xs font-bold text-amber-900 hover:underline disabled:opacity-50"
                    disabled={busy}
                    onClick={() =>
                      void resolvePendingRelease(release.reservationId, release.shipmentId, "undo")
                    }
                    type="button"
                  >
                    Undo
                  </button>
                </div>
              ))}
          </div>

          <header className="flex flex-col gap-4 border-b border-border px-6 py-5 sm:flex-row sm:items-start sm:justify-between sm:px-8">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-gold-dark">
                {BUSINESS.descriptor}
              </p>
              <h2 className="mt-1 font-serif text-2xl text-ink">{BUSINESS.name}</h2>
            </div>
            <div className="text-xs sm:text-right">
              <p className="font-serif text-2xl uppercase tracking-[0.1em] text-gold-dark">
                Invoice
              </p>
              {invoice.invoiceDate && (
                <p className="mt-1 text-muted">
                  Latest order:{" "}
                  <span className="font-semibold text-ink">
                    {formatDate(invoice.invoiceDate)}
                  </span>
                </p>
              )}
              <p className="text-muted">
                Status:{" "}
                <span className="font-semibold text-ink">{invoice.statusLabel}</span>
              </p>
            </div>
          </header>

          <section className="grid gap-4 border-b border-border px-6 py-5 sm:grid-cols-[1fr_auto] sm:px-8">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-gold-dark">
                Order for
              </p>
              <p className="mt-1 text-lg font-bold text-ink">{invoice.customerName}</p>
              {customerDetails.length > 0 && (
                <dl className="mt-1 space-y-0.5 text-sm leading-5">
                  {customerDetails.map(([label, value]) => (
                    <div className="flex flex-wrap gap-1.5" key={label}>
                      <dt className="text-muted">{label}:</dt>
                      <dd className="text-ink">{value}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
            {invoice.notes && (
              <div className="max-w-xs text-sm sm:text-right">
                <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-gold-dark">
                  Notes
                </p>
                <p className="mt-1 whitespace-pre-wrap leading-6 text-ink">{invoice.notes}</p>
              </div>
            )}
          </section>

          <section className="px-6 py-5 sm:px-8">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[600px] border-collapse text-left">
                <thead>
                  <tr className="border-y border-gold/50 bg-gold-soft text-[10px] uppercase tracking-[0.12em] text-gold-dark">
                    <th className="w-8 px-3 py-2.5" data-print-hide>
                      <input
                        aria-label={allIncluded ? "Leave out all items" : "Include all items"}
                        checked={allIncluded}
                        className="h-4 w-4 rounded border-border accent-ink"
                        onChange={toggleAll}
                        type="checkbox"
                      />
                    </th>
                    <th className="px-3 py-2.5 font-bold">Date</th>
                    <th className="px-3 py-2.5 font-bold">Item</th>
                    <th className="px-3 py-2.5 text-right font-bold">Qty</th>
                    <th className="px-3 py-2.5 text-right font-bold">Unit price</th>
                    <th className="px-3 py-2.5 text-right font-bold">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/80 text-[13px]">
                  {invoice.items.map((item) => {
                    const included = !excludedIds.includes(item.id);
                    return (
                      <tr
                        className={
                          included ? "even:bg-canvas/35" : "opacity-40 print:hidden"
                        }
                        data-print-hide={included ? undefined : true}
                        key={item.id}
                      >
                        <td className="px-3 py-3 align-top" data-print-hide>
                          <input
                            aria-label={
                              (included ? "Leave out " : "Include ") + item.itemName
                            }
                            checked={included}
                            className="h-4 w-4 rounded border-border accent-ink"
                            onChange={() => toggleItem(item.id)}
                            type="checkbox"
                          />
                        </td>
                        <td className="whitespace-nowrap px-3 py-3 align-top text-xs text-muted">
                          {formatOrderDateTime(item.orderedAt)}
                        </td>
                        <td className="break-words px-3 py-3 align-top font-semibold text-ink">
                          {formatItemLabel({ sku: item.sku, name: item.itemName, category: item.category })}
                          {item.pendingRelease && (
                            <span
                              className="ml-2 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-800"
                              data-print-hide
                            >
                              Release pending
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-3 text-right align-top tabular-nums">
                          {item.quantity}
                        </td>
                        <td className="px-3 py-3 text-right align-top tabular-nums">
                          {formatCurrency(item.unitPrice)}
                        </td>
                        <td className="px-3 py-3 text-right align-top font-bold tabular-nums text-ink">
                          {formatCurrency(item.lineTotal)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {!allIncluded && (
              <p className="mt-2 text-xs text-muted" data-print-hide>
                {excludedIds.length} item{excludedIds.length === 1 ? "" : "s"} left out of
                this invoice only. Reservation records are unchanged.
              </p>
            )}
          </section>

          <section className="ml-auto w-full max-w-sm px-6 pb-6 sm:px-8" data-print-totals>
            <InvoiceTotal label="Subtotal" value={displayInvoice.totals.subtotal} />
            {displayInvoice.totals.discount > 0 && (
              <InvoiceTotal label="Discount" value={-displayInvoice.totals.discount} />
            )}
            <InvoiceTotal emphasize label="Total" value={displayInvoice.totals.total} />
            <InvoiceTotal label="Amount paid" value={displayInvoice.totals.amountPaid} />
            <div className="mt-3 flex items-center justify-between gap-4 rounded-xl border border-gold/60 bg-gold-soft px-4 py-3">
              <span className="text-[11px] font-bold uppercase tracking-[0.16em] text-gold-dark">
                {orderStatus.label === "Cancelled" ? "Order cancelled" : "Balance due"}
              </span>
              <span className="whitespace-nowrap font-serif text-2xl font-bold tabular-nums text-ink">
                {orderStatus.label === "Cancelled"
                  ? "Nothing due"
                  : formatCurrency(displayInvoice.totals.balance)}
              </span>
            </div>
          </section>

          {orderActions && (
            <details className="group border-t border-border px-6 py-3 sm:px-8" data-print-hide>
              <summary className="cursor-pointer list-none text-xs font-bold uppercase tracking-[0.14em] text-muted hover:text-ink">
                <span className="group-open:hidden">▸</span>
                <span className="hidden group-open:inline">▾</span> More
                <span className="ml-1 font-normal normal-case tracking-normal">
                  (back to reserved, archive…)
                </span>
              </summary>
              <div className="mt-3">{orderActions}</div>
            </details>
          )}

          <footer className="border-t border-border bg-canvas/35 px-6 py-3 text-center sm:px-8">
            <p className="text-xs text-muted">
              Thank you for your business · {BUSINESS.name}
            </p>
          </footer>
        </article>
      </div>
    </div>
  );
}

function InvoiceTotal({
  label,
  value,
  emphasize = false,
}: {
  label: string;
  value: number;
  emphasize?: boolean;
}) {
  return (
    <div
      className={
        "flex items-baseline justify-between gap-6 text-sm " +
        (emphasize
          ? "mt-1 border-y border-gold/40 bg-gold-soft/70 px-3 py-2 font-bold text-ink"
          : "border-b border-border/60 py-1.5 text-muted")
      }
    >
      <span>{label}</span>
      <span className="whitespace-nowrap tabular-nums">{formatCurrency(value)}</span>
    </div>
  );
}
