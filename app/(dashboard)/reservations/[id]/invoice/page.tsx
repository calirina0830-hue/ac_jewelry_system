import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { transitionReservationStatus } from "@/actions/reservations";
import {
  InvoiceActionBar,
  InvoiceNotes,
} from "@/components/reservations/invoice-controls";
import { PrintInvoiceButton } from "@/components/reservations/print-invoice-button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { logActivity } from "@/lib/activity";
import { getCurrentProfile } from "@/lib/auth";
import { BUSINESS } from "@/lib/constants/business";
import { formatCurrency, formatDate } from "@/lib/format";
import {
  getInvoiceStatusLabel,
  getInvoiceTotals,
} from "@/lib/reservations/invoice";
import { getReservationTransitions } from "@/lib/reservations/status";
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

  const [{ data: items }, { data: payments }, { data: customer }] =
    await Promise.all([
      supabase
        .from("reservation_items")
        .select(
          "id, sku, category, item_name, quantity, unit_price, discount, line_total, created_at",
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
    ]);

  if (!items) notFound();

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
  const totalQuantity = items.reduce(
    (sum, item) => sum + Number(item.quantity),
    0,
  );
  const statusLabel = getInvoiceStatusLabel(reservation.status);
  const canWrite = profile?.role === "admin" || profile?.role === "staff";
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
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Link
            className="inline-flex h-11 items-center rounded-xl border border-border bg-white px-5 text-sm font-semibold text-ink hover:border-gold"
            href={"/reservations/" + reservation.id}
          >
            Back to reservation
          </Link>
          <PrintInvoiceButton />
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
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
                canWrite={canWrite && !reservation.archived_at}
                notes={reservation.notes}
                reservationId={reservation.id}
                updatedAt={reservation.updated_at}
              />
            </div>
          </div>
        </section>

        <section className="px-6 pt-5 sm:px-9" data-print-inset>
          <h2 className="sr-only">Jewelry Items</h2>
          <div className="overflow-x-auto" data-print-unclip>
            <table className="w-full min-w-[640px] border-collapse text-left">
              <thead>
                <tr className="border-b-2 border-gold bg-gold-soft text-[10px] uppercase tracking-[0.14em] text-gold-dark">
                  <th className="px-3 py-2.5 font-bold">No.</th>
                  <th className="px-3 py-2.5 font-bold">Item</th>
                  <th className="px-3 py-2.5 text-right font-bold">Quantity</th>
                  <th className="px-3 py-2.5 text-right font-bold">Unit Price</th>
                  <th className="px-3 py-2.5 text-right font-bold">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {items.map((item, index) => (
                  <tr key={item.id}>
                    <td className="px-3 py-2.5 align-top text-sm text-muted">
                      {index + 1}
                    </td>
                    <td className="break-words px-3 py-2.5 text-sm font-semibold text-ink">
                      {item.sku + " - " + item.item_name + " - " + item.category}
                    </td>
                    <td className="px-3 py-2.5 text-right align-top text-sm tabular-nums">
                      {item.quantity}
                    </td>
                    <td className="px-3 py-2.5 text-right align-top text-sm tabular-nums">
                      {formatCurrency(Number(item.unit_price))}
                    </td>
                    <td className="px-3 py-2.5 text-right align-top text-sm font-bold tabular-nums">
                      {formatCurrency(Number(item.line_total))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section
          className="ml-auto w-full max-w-sm px-6 pb-7 pt-5 sm:px-9"
          data-print-inset
          data-print-totals
        >
          <InvoiceTotal label="Subtotal" value={totals.subtotal} />
          <InvoiceTotal
            label="Reservation Discount"
            value={totals.reservationDiscount}
          />
          <div className="flex justify-between gap-6 py-1.5 text-sm text-muted">
            <span>Total Quantity</span>
            <span className="whitespace-nowrap tabular-nums">{totalQuantity}</span>
          </div>
          <InvoiceTotal emphasize label="Total" value={totals.total} />
          <InvoiceTotal label="Amount Paid" value={totals.amountPaid} />
          <div
            className="mt-3 flex items-center justify-between gap-4 border-2 border-gold bg-gold-soft px-4 py-3"
            data-print-band
          >
            <span className="text-[10px] font-bold uppercase tracking-[0.22em] text-gold-dark">
              Balance Due
            </span>
            <span className="whitespace-nowrap font-serif text-xl font-bold tabular-nums text-ink">
              {formatCurrency(totals.balance)}
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
