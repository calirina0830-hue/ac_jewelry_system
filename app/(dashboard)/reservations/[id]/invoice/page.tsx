import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { transitionReservationStatus } from "@/actions/reservations";
import {
  InvoiceActionBar,
  InvoiceNotes,
} from "@/components/reservations/invoice-controls";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { logActivity } from "@/lib/activity";
import { getCurrentProfile, roleCanWrite } from "@/lib/auth";
import { BUSINESS } from "@/lib/constants/business";
import { formatCurrency, formatDate, formatOrderDateTime } from "@/lib/format";
import {
  getInvoiceStatusLabel,
  getInvoiceTotals,
} from "@/lib/reservations/invoice";
import { getReservationTransitions } from "@/lib/reservations/status";
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

  const supabase = await createClient();
  const profile = await getCurrentProfile();
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
      .select("id, status, downpayment_applied")
      .eq("reservation_id", reservation.id),
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

  const paymentTotal = payments?.length
    ? payments
        .filter((payment) => !payment.voided_at)
        .reduce((total, payment) => total + Number(payment.amount), 0)
    : undefined;
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
      return {
        id: item.id,
        sku: item.sku,
        item_name: item.item_name,
        category: item.category,
        ordered_at: item.ordered_at,
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
  const cancelTransition = getReservationTransitions(
    profile?.role,
    reservation.status,
  ).find((transition) => transition.to === "cancelled");
  const customerDetails = [
    { label: "Facebook / CS Name", value: customer?.facebook_name },
    { label: "Phone", value: customer?.phone },
    { label: "Address", value: customer?.address },
  ].filter((detail) => Boolean(detail.value));

  return (
    <div className="mx-auto max-w-3xl px-5 py-8 sm:px-8" data-print-page>
      <div className="mb-5 space-y-3" data-print-hide>
        <Link
          className="inline-flex h-11 items-center rounded-xl border border-border bg-white px-5 text-sm font-semibold text-ink hover:border-gold"
          href={"/reservations/" + reservation.id}
        >
          Back to reservation
        </Link>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <a
            className="inline-flex h-9 items-center rounded-lg border border-border bg-white px-3 text-sm font-semibold text-ink transition hover:border-gold hover:bg-canvas"
            href={"/reservations/" + reservation.id + "/invoice/pdf"}
          >
            Download PDF
          </a>
          <InvoiceActionBar
            balance={totals.balance}
            canWrite={canWrite && !reservation.archived_at && reservation.status !== "cancelled"}
            deliveredAt={reservation.delivered_at}
            notes={reservation.notes}
            pricingComplete={reservation.pricing_complete}
            reservationId={reservation.id}
            updatedAt={reservation.updated_at}
          />
          {cancelTransition && !reservation.archived_at && (
            <div className="[&_button]:h-11 [&_button]:rounded-lg">
              <ConfirmAction
                action={transitionReservationStatus.bind(
                  null,
                  reservation.id,
                  "cancelled",
                  reservation.updated_at,
                )}
                appearance="compact-danger"
                confirmation={cancelTransition.confirmation}
                variant="danger"
              >
                CANCEL
              </ConfirmAction>
            </div>
          )}
        </div>
      </div>

      <article className="border border-border bg-white shadow-card" data-print-root>
        <div className="h-1 bg-gold" data-print-band />
        <header
          className="flex flex-col gap-6 border-b-2 border-gold px-6 py-6 sm:flex-row sm:items-start sm:justify-between sm:px-9"
          data-print-inset
        >
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.32em] text-gold-dark">
              {BUSINESS.descriptor}
            </p>
            <h1 className="mt-1.5 font-serif text-3xl leading-tight text-ink">
              {BUSINESS.name}
            </h1>
            <p className="mt-1.5 text-[10px] uppercase tracking-[0.22em] text-muted">
              {BUSINESS.systemLabel}
            </p>
          </div>
          <div className="shrink-0 sm:text-right">
            <p className="font-serif text-3xl uppercase tracking-[0.14em] text-gold-dark">
              Invoice
            </p>
            <div className="mt-3 space-y-1.5 text-xs">
              <div className="flex justify-between gap-8 sm:justify-end">
                <span className="uppercase tracking-[0.12em] text-muted">
                  Invoice No
                </span>
                <span className="font-semibold text-ink">
                  {reservation.reservation_no}
                </span>
              </div>
              <div className="flex justify-between gap-8 sm:justify-end">
                <span className="uppercase tracking-[0.12em] text-muted">
                  Date
                </span>
                <span className="font-semibold text-ink">
                  {formatDate(reservation.reserved_at)}
                </span>
              </div>
              <div className="flex justify-between gap-8 sm:justify-end">
                <span className="uppercase tracking-[0.12em] text-muted">
                  Reservation
                </span>
                <span className="inline-flex rounded-full border border-gold bg-gold-soft px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-gold-dark">
                  {statusLabel}
                </span>
              </div>
              <div className="flex justify-between gap-8 sm:justify-end">
                <span className="uppercase tracking-[0.12em] text-muted">
                  Delivery
                </span>
                <span
                  className={
                    "inline-flex rounded-full border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide " +
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
          className="grid gap-6 border-b border-border px-6 py-5 sm:grid-cols-2 sm:px-9"
          data-print-inset
        >
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-gold-dark">
              Order For
            </p>
            <p className="mt-1.5 text-base font-bold text-ink">
              {customer?.name ?? "Not provided"}
            </p>
            {customerDetails.length > 0 && (
              <dl className="mt-2 space-y-1 text-xs">
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
          <div>
            <div className="border-t border-border pt-3 sm:text-left">
              <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-gold-dark">
                Invoice From
              </p>
              <p className="mt-1.5 text-base font-bold text-ink">
                {BUSINESS.name}
              </p>
              <p className="text-xs text-muted">{BUSINESS.descriptor}</p>
            </div>
            <div className="mt-4">
              <InvoiceNotes
                canWrite={false}
                notes={reservation.notes}
                reservationId={reservation.id}
                updatedAt={reservation.updated_at}
              />
            </div>
          </div>
        </section>

        <section className="px-6 pt-5 sm:px-9" data-print-inset>
          {releaseLedger.releasedUnits > 0 && (
            <div
              className="mb-5 rounded-lg border border-gold bg-gold-soft px-4 py-3 text-xs sm:text-sm"
              data-print-band
            >
              <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-gold-dark">
                Already released &amp; billed separately
              </p>
              <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-6 gap-y-1">
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
            <table className="w-full min-w-[640px] border-collapse text-left">
              <thead>
                <tr className="border-b-2 border-gold bg-gold-soft text-[10px] uppercase tracking-[0.14em] text-gold-dark">
                  <th className="px-3 py-2.5 font-bold">No.</th>
                  <th className="px-3 py-2.5 font-bold">Item</th>
                  <th className="px-3 py-2.5 font-bold">Order Date</th>
                  <th className="px-3 py-2.5 text-right font-bold">Quantity</th>
                  <th className="px-3 py-2.5 text-right font-bold">Unit Price</th>
                  <th className="px-3 py-2.5 text-right font-bold">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {displayItems.length === 0 ? (
                  <tr>
                    <td
                      colSpan={6}
                      className="px-3 py-6 text-center text-sm text-muted"
                    >
                      All reserved items have been released.
                    </td>
                  </tr>
                ) : (
                  displayItems.map((item, index) => (
                    <tr key={item.id}>
                      <td className="px-3 py-2.5 align-top text-sm text-muted">
                        {index + 1}
                      </td>
                      <td className="break-words px-3 py-2.5 text-sm font-semibold text-ink">
                        {item.sku + " - " + item.item_name + " - " + item.category}
                        {item.releasedQty > 0 && (
                          <p className="mt-0.5 text-xs font-normal text-muted">
                            {item.releasedQty} of {item.originalQty}{" "}
                            released; {item.quantity} remaining
                          </p>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 align-top text-sm text-muted">
                        {formatOrderDateTime(item.ordered_at)}
                      </td>
                      <td className="px-3 py-2.5 text-right align-top text-sm tabular-nums">
                        {item.quantity}
                      </td>
                      <td className="px-3 py-2.5 text-right align-top text-sm tabular-nums">
                        {formatCurrency(item.unit_price)}
                      </td>
                      <td className="px-3 py-2.5 text-right align-top text-sm font-bold tabular-nums">
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
          className="ml-auto w-full max-w-sm px-6 pb-7 pt-5 sm:px-9"
          data-print-inset
          data-print-totals
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
          {downpaymentCommitted > 0 && (
            <InvoiceTotal
              label="Applied to released goods"
              value={-downpaymentCommitted}
            />
          )}
          <div
            className="mt-3 flex items-center justify-between gap-4 border-2 border-gold bg-gold-soft px-4 py-3"
            data-print-band
          >
            <span className="text-[10px] font-bold uppercase tracking-[0.22em] text-gold-dark">
              Balance Due
            </span>
            <span className="whitespace-nowrap font-serif text-xl font-bold tabular-nums text-ink">
              {formatCurrency(balanceDue)}
            </span>
          </div>
        </section>

        <footer
          className="border-t border-border px-6 py-4 text-center sm:px-9"
          data-print-inset
        >
          <p className="text-[11px] text-muted">
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
        "flex justify-between gap-6 py-1.5 text-sm " +
        (emphasize ? "font-bold text-ink" : "text-muted")
      }
    >
      <span>{label}</span>
      <span className="whitespace-nowrap tabular-nums">
        {formatCurrency(value)}
      </span>
    </div>
  );
}
