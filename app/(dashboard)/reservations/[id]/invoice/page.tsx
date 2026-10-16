import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { InvoiceActionBar } from "@/components/reservations/invoice-controls";
import { InvoiceReleaseModal } from "@/components/reservations/invoice-release-modal";
import { logActivity } from "@/lib/activity";
import { getCurrentProfile, roleCanWrite } from "@/lib/auth";
import { BUSINESS } from "@/lib/constants/business";
import { formatCurrency, formatDate, formatOrderDateTime } from "@/lib/format";
import {
  getInvoiceStatusLabel,
  getInvoiceTotals,
} from "@/lib/reservations/invoice";
import { computeReleaseLedger } from "@/lib/reservations/release";
import { createClient } from "@/lib/supabase/server";
import { reservationIdSchema } from "@/lib/validation/reservations";

export const metadata: Metadata = { title: "Reservation invoice" };

export default async function ReservationInvoicePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const parsedId = reservationIdSchema.safeParse(id);

  if (!parsedId.success) notFound();

  const [supabase, profile] = await Promise.all([
    createClient(),
    getCurrentProfile(),
  ]);
  const { data: reservation } = await supabase
    .from("reservations")
    .select("*")
    .eq("id", parsedId.data)
    .maybeSingle();

  if (!reservation) notFound();

  const [
    { data: items },
    { data: payments },
    { data: customer },
    { data: shipments },
  ] = await Promise.all([
    supabase
      .from("reservation_items")
      .select(
        "id, sku, category, item_name, quantity, unit_price, discount, line_total, ordered_at, created_at",
      )
      .eq("reservation_id", reservation.id)
      .order("created_at"),
    supabase
      .from("reservation_payments")
      .select("amount, voided_at")
      .eq("reservation_id", reservation.id),
    supabase
      .from("customers")
      .select("name, facebook_name, phone, address")
      .eq("id", reservation.customer_id)
      .maybeSingle(),
    supabase
      .from("reservation_shipments")
      .select("id, shipment_no, status, downpayment_applied, created_at, shipped_at, notes")
      .eq("reservation_id", reservation.id)
      .order("created_at", { ascending: false }),
  ]);

  if (!items) notFound();

  const shipmentIdForReservation =
    shipments?.map((shipment) => shipment.id) ?? [];
  const { data: shipmentItems } =
    shipmentIdForReservation.length > 0
      ? await supabase
          .from("reservation_shipment_items")
          .select("shipment_id, reservation_item_id, quantity")
          .in("shipment_id", shipmentIdForReservation)
          .order("created_at")
      : { data: [] };
  const safeShipmentItems = shipmentItems ?? [];

  const releaseLedger = computeReleaseLedger(
    (items ?? []).map((item) => ({
      id: item.id,
      description: item.sku + " - " + item.item_name + " - " + item.category,
      quantity: Number(item.quantity),
      unitPrice: Number(item.unit_price),
      discount: Number(item.discount ?? 0),
    })),
    (shipments ?? []).map((shipment) => ({
      id: shipment.id,
      status: shipment.status,
      downpayment_applied: Number(shipment.downpayment_applied ?? 0),
    })),
    safeShipmentItems.map((line) => ({
      shipment_id: line.shipment_id,
      reservation_item_id: line.reservation_item_id,
      quantity: Number(line.quantity),
    })),
  );

  await logActivity(supabase, {
    action: "invoice_viewed",
    entityType: "reservation",
    entityId: reservation.id,
    description:
      "Viewed or printed invoice " + reservation.reservation_no + ".",
  });

  const paymentTotal = (payments ?? [])
    .filter((payment) => !payment.voided_at)
    .reduce((total, payment) => total + Number(payment.amount), 0);
  const totals = getInvoiceTotals(reservation, paymentTotal);

  const grossTotal = releaseLedger.items.reduce(
    (sum, item) => sum + item.grossValue,
    0,
  );
  const grossRemaining = releaseLedger.items.reduce(
    (sum, item) => sum + item.unitPrice * item.remainingQty,
    0,
  );
  const remainingFraction = grossTotal > 0 ? grossRemaining / grossTotal : 0;
  const remainingReservationDiscount =
    Number(reservation.discount) * remainingFraction;
  const remainingTotal = Math.max(
    releaseLedger.remainingSubtotal - remainingReservationDiscount,
    0,
  );
  const downpaymentCommitted = releaseLedger.downpaymentCommitted;
  const downpaymentAmount = Number(reservation.downpayment);
  const remainingUnapplied = Math.max(
    totals.amountPaid - downpaymentCommitted,
    0,
  );
  const balanceDue = Math.max(remainingTotal - remainingUnapplied, 0);
  const releaseById = new Map(
    releaseLedger.items.map((item) => [item.id, item]),
  );
  const displayItems = (items ?? [])
    .filter(
      (item) => (releaseById.get(item.id)?.remainingQty ?? Number(item.quantity)) > 0,
    )
    .map((item) => {
      const ledger = releaseById.get(item.id);
      const remainingQty = ledger?.remainingQty ?? Number(item.quantity);
      const releasedQty = ledger?.releasedQty ?? 0;
      const orderDate = item.ordered_at || item.created_at || reservation.reserved_at;
      return {
        id: item.id,
        sku: item.sku,
        item_name: item.item_name,
        category: item.category,
        ordered_at: orderDate,
        quantity: remainingQty,
        originalQty: Number(item.quantity),
        releasedQty,
        unit_price: Number(item.unit_price),
        line_total: Math.max(
          Number(item.line_total) - (ledger?.releasedSubtotal ?? 0),
          0,
        ),
      };
    });
  const statusLabel = getInvoiceStatusLabel(reservation.status);
  const canWrite = roleCanWrite(profile?.role);
  const customerDetails = [
    { label: "Facebook / CS Name", value: customer?.facebook_name },
    { label: "Phone", value: customer?.phone },
    { label: "Address", value: customer?.address },
  ].filter((detail) => Boolean(detail.value));

  const releaseItems = displayItems.map((item) => ({
    id: item.id,
    sku: item.sku,
    itemName: item.item_name,
    category: item.category,
    orderedAt: item.ordered_at,
    remainingQty: item.quantity,
    originalQty: item.originalQty,
    unitPrice: item.unit_price,
    lineTotal: item.line_total,
  }));

  const itemMap = new Map((items ?? []).map((it) => [it.id, it]));
  const releaseHistory = (shipments ?? []).map((shipment) => {
    const lines = safeShipmentItems
      .filter((sItem) => sItem.shipment_id === shipment.id)
      .map((sItem) => {
        const orig = itemMap.get(sItem.reservation_item_id);
        const quantity = Number(sItem.quantity);
        const originalQuantity = Number(orig?.quantity ?? 0);
        const proratedDiscount = orig && originalQuantity > 0
          ? (Number(orig.discount ?? 0) * quantity) / originalQuantity
          : 0;
        return {
          description: orig
            ? `${orig.sku} - ${orig.item_name} - ${orig.category}`
            : "Reserved item",
          quantity,
          subtotal: orig
            ? Math.max(Number(orig.unit_price) * quantity - proratedDiscount, 0)
            : 0,
        };
      });
    const releasedSubtotal = lines.reduce((total, line) => total + line.subtotal, 0);
    const downpaymentApplied = Number(shipment.downpayment_applied ?? 0);
    return {
      id: shipment.id,
      shipmentNo: shipment.shipment_no,
      status: shipment.status as "pending" | "shipped" | "cancelled",
      createdAt: shipment.created_at,
      shippedAt: shipment.shipped_at,
      releasedSubtotal,
      downpaymentApplied,
      remainingBalance: Math.max(releasedSubtotal - downpaymentApplied, 0),
      notes: shipment.notes,
      items: lines,
    };
  });

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-8 lg:py-12" data-print-page>
      <div className="mb-6 space-y-3" data-print-hide>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Link
            className="inline-flex h-11 items-center rounded-xl border border-border bg-white px-5 text-sm font-semibold text-ink hover:border-gold"
            href={"/reservations/" + reservation.id}
          >
            Back to reservation
          </Link>
          <InvoiceReleaseModal
            reservationId={reservation.id}
            reservationNo={reservation.reservation_no}
            items={releaseItems}
            availableDownpayment={Math.max(
              downpaymentAmount - downpaymentCommitted,
              0,
            )}
            canRelease={
              canWrite &&
              !reservation.archived_at &&
              ["reserved", "paid", "delivered"].includes(reservation.status)
            }
            history={releaseHistory}
          />
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {/* Download PDF action endpoint: /invoice/pdf */}
          <InvoiceActionBar
            balance={totals.balance}
            canWrite={canWrite && !reservation.archived_at && reservation.status !== "cancelled"}
            deliveredAt={reservation.delivered_at}
            notes={reservation.notes}
            pricingComplete={reservation.pricing_complete}
            reservationId={reservation.id}
            updatedAt={reservation.updated_at}
          />
        </div>
      </div>

      <article
        className="overflow-hidden rounded-2xl border border-border bg-white shadow-card"
        data-print-root
      >
        <div className="h-1 bg-gold" data-print-band />
        <header
          className="flex flex-col gap-8 border-b border-border px-7 py-8 sm:flex-row sm:items-start sm:justify-between sm:px-10 sm:py-9"
          data-print-inset
        >
          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.24em] text-gold-dark">
              {BUSINESS.descriptor}
            </p>
            <h1 className="mt-2 font-serif text-3xl leading-tight text-ink sm:text-4xl">
              {BUSINESS.name}
            </h1>
            <p className="mt-2 text-xs uppercase tracking-[0.18em] text-muted">
              {BUSINESS.systemLabel}
            </p>
          </div>
          <div className="shrink-0 rounded-xl border border-border bg-canvas/60 p-4 sm:min-w-[275px]">
            <p className="font-serif text-3xl uppercase tracking-[0.12em] text-gold-dark sm:text-right">
              Invoice
            </p>
            <div className="mt-4 space-y-2.5 text-xs">
              <div className="flex justify-between gap-6 sm:justify-end">
                <span className="uppercase tracking-[0.1em] text-muted">
                  Invoice No
                </span>
                <span className="font-bold tabular-nums text-ink">
                  {reservation.reservation_no}
                </span>
              </div>
              <div className="flex justify-between gap-6 sm:justify-end">
                <span className="uppercase tracking-[0.1em] text-muted">
                  Date
                </span>
                <span className="font-semibold text-ink">
                  {formatDate(reservation.reserved_at)}
                </span>
              </div>
              <div className="flex justify-between gap-6 sm:justify-end">
                <span className="uppercase tracking-[0.1em] text-muted">
                  Reservation
                </span>
                <span className="inline-flex rounded-full border border-gold/40 bg-gold-soft px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-gold-dark">
                  {statusLabel}
                </span>
              </div>
              <div className="flex justify-between gap-6 sm:justify-end">
                <span className="uppercase tracking-[0.1em] text-muted">
                  Delivery
                </span>
                <span
                  className={
                    "inline-flex rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide " +
                    (reservation.delivered_at
                      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                      : "border-border bg-canvas text-muted")
                  }
                >
                  {reservation.delivered_at ? "Delivered" : "Not delivered"}
                </span>
              </div>
            </div>
          </div>
        </header>

        <section
          className="grid gap-5 border-b border-border px-7 py-6 sm:grid-cols-2 sm:px-10 sm:py-7"
          data-print-inset
        >
          <div className="rounded-xl border border-border/80 bg-white p-4 sm:p-5">
            <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-gold-dark">
              Order For
            </p>
            <p className="mt-2 text-lg font-bold text-ink">
              {customer?.name ?? "Not provided"}
            </p>
            {customerDetails.length > 0 && (
              <dl className="mt-3 space-y-1.5 text-sm leading-5">
                {customerDetails.map((detail) => (
                  <div key={detail.label} className="flex flex-wrap gap-1.5">
                    <dt className="font-semibold text-muted">
                      {detail.label}:
                    </dt>
                    <dd className="text-ink">{detail.value}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
          <div className="rounded-xl border border-border/80 bg-canvas/40 p-4 sm:p-5">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-gold-dark">
                Invoice From
              </p>
              <p className="mt-2 text-lg font-bold text-ink">
                {BUSINESS.name}
              </p>
              <p className="mt-1 text-sm text-muted">{BUSINESS.descriptor}</p>
            </div>
            <div className="mt-4 border-t border-border/80 pt-3">
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted">
                Notes
              </p>
              <p className="mt-1.5 whitespace-pre-wrap text-sm leading-6 text-ink">
                {reservation.notes?.trim() ? (
                  reservation.notes
                ) : (
                  <span className="text-muted">No notes recorded</span>
                )}
              </p>
            </div>
          </div>
        </section>

        <section className="px-7 pt-6 sm:px-10 sm:pt-7" data-print-inset>
          {releaseLedger.releasedUnits > 0 && (
            <div
              className="mb-6 rounded-xl border border-gold/40 bg-gold-soft/70 px-4 py-4 text-sm"
              data-print-band
            >
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-gold-dark">
                Already released &amp; billed separately
              </p>
              <div className="mt-2 flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
                <span className="text-ink">
                  {releaseLedger.releasedUnits} unit
                  {releaseLedger.releasedUnits === 1 ? "" : "s"} worth{" "}
                  {formatCurrency(releaseLedger.releasedSubtotal)}
                </span>
                <span className="text-muted">
                  Downpayment applied to released goods:{" "}
                  <strong className="text-ink">
                    {formatCurrency(downpaymentCommitted)}
                  </strong>
                </span>
              </div>
            </div>
          )}
          <h2 className="sr-only">Jewelry Items</h2>
          <div className="overflow-x-auto" data-print-unclip>
            <table className="w-full min-w-[700px] border-collapse text-left">
              <thead>
                <tr className="border-y border-gold/50 bg-gold-soft text-[11px] uppercase tracking-[0.12em] text-gold-dark">
                  <th className="px-4 py-3 font-bold">
                    Date
                    <span className="sr-only"> (Order Date)</span>
                  </th>
                  <th className="px-4 py-3 font-bold">No.</th>
                  <th className="px-4 py-3 font-bold">Item</th>
                  <th className="px-4 py-3 text-right font-bold">Quantity</th>
                  <th className="px-4 py-3 text-right font-bold">Unit Price</th>
                  <th className="px-4 py-3 text-right font-bold">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/80 text-[13px]">
                {displayItems.length === 0 ? (
                  <tr>
                    <td
                      colSpan={6}
                      className="px-4 py-8 text-center text-sm text-muted"
                    >
                      All reserved items have been released.
                    </td>
                  </tr>
                ) : (
                  displayItems.map((item, index) => (
                    <tr className="even:bg-canvas/35" key={item.id}>
                      <td className="whitespace-nowrap px-4 py-4 align-top text-xs text-muted">
                        {formatOrderDateTime(item.ordered_at)}
                      </td>
                      <td className="px-4 py-4 align-top text-sm text-muted">
                        {index + 1}
                      </td>
                      <td className="break-words px-4 py-4 text-sm font-semibold leading-6 text-ink">
                        {item.sku + " - " + item.item_name + " - " + item.category}
                        {item.releasedQty > 0 && (
                          <p className="mt-0.5 text-xs font-normal text-muted">
                            {item.releasedQty} of {item.originalQty}{" "}
                            released; {item.quantity} remaining
                          </p>
                        )}
                      </td>
                      <td className="px-4 py-4 text-right align-top text-sm tabular-nums">
                        {item.quantity}
                      </td>
                      <td className="px-4 py-4 text-right align-top text-sm tabular-nums">
                        {formatCurrency(item.unit_price)}
                      </td>
                      <td className="px-4 py-4 text-right align-top text-sm font-bold tabular-nums text-ink">
                        {formatCurrency(item.line_total)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section
          className="ml-auto w-full max-w-md px-7 pb-8 pt-6 sm:px-10 sm:pb-9"
          data-print-inset
          data-print-totals
        >
          <div
            className="rounded-2xl border border-border bg-canvas/45 p-5 sm:p-6"
            data-print-summary-card
          >
            <InvoiceTotal
              label={
                releaseLedger.releasedUnits > 0
                  ? "Subtotal (remaining items)"
                  : "Subtotal"
              }
              value={releaseLedger.remainingSubtotal}
            />
            <InvoiceTotal
              label="Reservation Discount"
              value={remainingReservationDiscount}
            />
            <div className="flex justify-between gap-6 py-1.5 text-sm text-muted">
              <span>Total Quantity</span>
              <span className="whitespace-nowrap tabular-nums">
                {releaseLedger.remainingUnits}
              </span>
            </div>
            <InvoiceTotal emphasize label="Total" value={remainingTotal} />
            <InvoiceTotal label="Amount Paid" value={totals.amountPaid} />
            <InvoiceTotal label="Downpayment" value={downpaymentAmount} />
            {downpaymentCommitted > 0 && (
              <InvoiceTotal
                label="Applied downpayment to released items"
                value={-downpaymentCommitted}
              />
            )}
            <InvoiceTotal
              label="Remaining Downpayment Balance"
              value={Math.max(downpaymentAmount - downpaymentCommitted, 0)}
            />
            <div
              className="mt-4 flex items-center justify-between gap-4 rounded-xl border border-gold/60 bg-gold-soft px-5 py-4"
              data-print-band
            >
              <span className="text-[11px] font-bold uppercase tracking-[0.16em] text-gold-dark">
                Balance Due
              </span>
              <span className="whitespace-nowrap font-serif text-2xl font-bold tabular-nums text-ink">
                {formatCurrency(balanceDue)}
              </span>
            </div>
          </div>
        </section>

        <footer
          className="border-t border-border bg-canvas/35 px-7 py-5 text-center sm:px-10"
          data-print-inset
        >
          <p className="text-xs text-muted">
            Thank you for your business &middot; {BUSINESS.name} &middot;{" "}
            {BUSINESS.systemLabel}
          </p>
        </footer>
      </article>
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
          ? "mt-2 border-y border-gold/40 bg-gold-soft/70 px-3 py-3 font-bold text-ink"
          : "border-b border-border/60 py-2 text-muted")
      }
    >
      <span>{label}</span>
      <span className="whitespace-nowrap tabular-nums">
        {formatCurrency(value)}
      </span>
    </div>
  );
}
