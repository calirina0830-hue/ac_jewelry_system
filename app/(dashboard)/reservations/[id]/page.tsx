import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import {
  archiveReservation,
  restoreReservation,
  transitionReservationStatus,
} from "@/actions/reservations";
import { OrderDateEditor } from "@/components/reservations/order-date-editor";
import { PaymentEvidenceViewer } from "@/components/reservations/payment-evidence-viewer";
import { ReleaseStatusBadge } from "@/components/reservations/release-status";
import { ReservationStatus } from "@/components/reservations/reservation-status";
import { ShippingPanel } from "@/components/reservations/shipping-panel";
import { StockImage } from "@/components/stock/stock-image";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { PageHeader } from "@/components/ui/page-header";
import { PageNotice } from "@/components/ui/page-notice";
import { getCurrentProfile, roleCanWrite, roleIsAdmin } from "@/lib/auth";
import { formatCurrency, formatDateTime } from "@/lib/format";
import {
  canRecordReservationPayment,
  needsReservationPricing,
} from "@/lib/reservations/payment-eligibility";
import { getReleaseDisplayStatus } from "@/lib/reservations/release";
import { createClient } from "@/lib/supabase/server";
import { getReservationTransitions } from "@/lib/reservations/status";
import { getPaymentEvidenceUrl } from "@/lib/storage/payment-evidence";
import { getStockImageUrl } from "@/lib/storage/stock-images";
import { reservationIdSchema } from "@/lib/validation/reservations";

export const metadata: Metadata = { title: "Reservation details" };

export default async function ReservationDetailsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ message?: string; error?: string }>;
}) {
  const { id } = await params;
  const notices = await searchParams;
  const parsedId = reservationIdSchema.safeParse(id);

  if (!parsedId.success) {
    notFound();
  }

  const profile = await getCurrentProfile();
  const canWrite = roleCanWrite(profile?.role);
  const isAdmin = roleIsAdmin(profile?.role);
  const supabase = await createClient();
  const { data: reservation } = await supabase
    .from("reservations")
    .select("*")
    .eq("id", parsedId.data)
    .maybeSingle();

  if (!reservation) {
    notFound();
  }

  const [
    { data: customer },
    { data: items },
    { data: statusHistory },
    { data: payments },
  ] = await Promise.all([
    supabase
      .from("customers")
      .select("id, name, facebook_name, phone, address")
      .eq("id", reservation.customer_id)
      .maybeSingle(),
    supabase
      .from("reservation_items")
      .select("*")
      .eq("reservation_id", reservation.id)
      .order("created_at"),
    supabase.rpc("get_reservation_status_history", {
      p_reservation_id: reservation.id,
    }),
    supabase
      .from("reservation_payments")
      .select("*")
      .eq("reservation_id", reservation.id)
      .order("recorded_at", { ascending: false }),
  ]);

  const { data: shipments } = await supabase
    .from("reservation_shipments")
    .select("id, shipment_no, status, created_at, shipped_at, downpayment_applied, notes, cancel_reason")
    .eq("reservation_id", reservation.id)
    .order("created_at", { ascending: false });
  const shipmentIds = (shipments ?? []).map((shipment) => shipment.id);
  const { data: shipmentItems } = shipmentIds.length
    ? await supabase
        .from("reservation_shipment_items")
        .select("shipment_id, reservation_item_id, quantity")
        .in("shipment_id", shipmentIds)
    : { data: [] };
  const shipmentStatusById = new Map(
    (shipments ?? []).map((shipment) => [shipment.id, shipment.status]),
  );
  const shippedByItem = new Map<string, number>();
  const pendingByItem = new Map<string, number>();
  const shipmentAggregates = new Map<
    string,
    { itemCount: number; totalQuantity: number }
  >();
  for (const shipmentItem of shipmentItems ?? []) {
    const quantity = Number(shipmentItem.quantity);
    const status = shipmentStatusById.get(shipmentItem.shipment_id);
    if (status === "shipped") {
      shippedByItem.set(
        shipmentItem.reservation_item_id,
        (shippedByItem.get(shipmentItem.reservation_item_id) ?? 0) + quantity,
      );
    } else if (status === "pending") {
      pendingByItem.set(
        shipmentItem.reservation_item_id,
        (pendingByItem.get(shipmentItem.reservation_item_id) ?? 0) + quantity,
      );
    }
    const aggregate = shipmentAggregates.get(shipmentItem.shipment_id) ?? {
      itemCount: 0,
      totalQuantity: 0,
    };
    aggregate.itemCount += 1;
    aggregate.totalQuantity += quantity;
    shipmentAggregates.set(shipmentItem.shipment_id, aggregate);
  }
  const shippingItems = (items ?? []).map((item) => ({
    id: item.id,
    label: item.sku + " - " + item.item_name + " - " + item.category,
    quantity: Number(item.quantity),
    unitPrice: Number(item.unit_price),
    discount: Number(item.discount ?? 0),
    orderedAt: item.ordered_at,
    shipped: shippedByItem.get(item.id) ?? 0,
    pending: pendingByItem.get(item.id) ?? 0,
  }));
  const shipmentRows = (shipments ?? []).map((shipment) => {
    const aggregate = shipmentAggregates.get(shipment.id) ?? {
      itemCount: 0,
      totalQuantity: 0,
    };
    return {
      id: shipment.id,
      shipmentNo: shipment.shipment_no,
      status: shipment.status,
      createdAt: shipment.created_at,
      shippedAt: shipment.shipped_at,
      itemCount: aggregate.itemCount,
      totalQuantity: aggregate.totalQuantity,
      downpaymentApplied: Number(shipment.downpayment_applied ?? 0),
      notes: shipment.notes,
      cancelReason: shipment.cancel_reason,
    };
  });
  const usedDownpayment = (shipments ?? [])
    .filter((shipment) => shipment.status === "shipped")
    .reduce(
      (total, shipment) => total + Number(shipment.downpayment_applied ?? 0),
      0,
    );
  const reservedDownpayment = (shipments ?? [])
    .filter((shipment) => shipment.status === "pending")
    .reduce(
      (total, shipment) => total + Number(shipment.downpayment_applied ?? 0),
      0,
    );
  const totalQuantity = (items ?? []).reduce(
    (total, item) => total + Number(item.quantity),
    0,
  );
  const releasedQuantity = [...shippedByItem.values()].reduce(
    (total, quantity) => total + quantity,
    0,
  );
  const releaseStatus = getReleaseDisplayStatus(
    releasedQuantity,
    totalQuantity,
  );
  const canShip =
    canWrite &&
    !reservation.archived_at &&
    ["reserved", "paid", "delivered"].includes(reservation.status);

  const transitions = getReservationTransitions(
    profile?.role,
    reservation.status,
  ).filter(
    (transition) =>
      transition.to !== "delivered" || !reservation.delivered_at,
  );
  const paymentIds = (payments ?? []).map((payment) => payment.id);
  const { data: paymentEvidence } = await supabase
    .from("reservation_payment_evidence")
    .select("*")
    .in(
      "payment_id",
      paymentIds.length
        ? paymentIds
        : ["00000000-0000-0000-0000-000000000000"],
    )
    .order("created_at");
  const evidenceByPayment = new Map<string, NonNullable<typeof paymentEvidence>>();
  for (const evidence of paymentEvidence ?? []) {
    evidenceByPayment.set(evidence.payment_id, [
      ...(evidenceByPayment.get(evidence.payment_id) ?? []),
      evidence,
    ]);
  }
  let createdBy = reservation.created_by
    ? "User " + reservation.created_by.slice(0, 8)
    : "Former team member";

  if (reservation.created_by) {
    const { data: creator } = await supabase
      .from("profiles")
      .select("full_name")
      .eq("id", reservation.created_by)
      .maybeSingle();
    createdBy = creator?.full_name ?? createdBy;
  }
  const paymentUserIds = [
    ...new Set(
      (payments ?? []).flatMap((payment) =>
        [payment.recorded_by, payment.voided_by].filter(
          (value): value is string => Boolean(value),
        ),
      ),
    ),
  ];
  const { data: paymentProfiles } = paymentUserIds.length
    ? await supabase
        .from("profiles")
        .select("id, full_name")
        .in("id", paymentUserIds)
    : { data: [] };
  const paymentNames = new Map(
    (paymentProfiles ?? []).map((entry) => [entry.id, entry.full_name]),
  );
  const activePaymentTotal = (payments ?? [])
    .filter((payment) => !payment.voided_at)
    .reduce((total, payment) => total + Number(payment.amount), 0);
  const displayedPaidAmount = payments?.length
    ? activePaymentTotal
    : Number(reservation.downpayment);

  return (
    <div className="mx-auto max-w-[1250px] px-5 py-8 sm:px-8 lg:px-10 lg:py-10">
      <PageHeader
        description="Customer commitment, jewelry snapshots, and server-verified financial totals."
        eyebrow="Reservation details"
        title={reservation.reservation_no}
      >
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
          <Link
            className="inline-flex h-9 items-center rounded-lg px-2 text-sm font-semibold text-muted transition hover:bg-white hover:text-ink"
            href="/reservations"
          >
            &larr; Reservations
          </Link>
          <Link
            className="inline-flex h-9 items-center rounded-lg border border-border bg-white px-3 text-sm font-semibold text-ink transition hover:border-gold hover:bg-canvas"
            href={"/reservations/" + reservation.id + "/invoice"}
          >
            Invoice
          </Link>
          {canWrite && !reservation.archived_at && reservation.status === "reserved" && (
            <Link
              className="inline-flex h-9 items-center rounded-lg border border-border bg-white px-3 text-sm font-semibold text-ink transition hover:border-gold hover:bg-canvas"
              href={"/reservations/" + reservation.id + "/edit"}
            >
              {needsReservationPricing(reservation) ? "Complete pricing" : "Edit"}
            </Link>
          )}
          {canWrite && canRecordReservationPayment(reservation) && (
              <Link
                className="relative z-10 inline-flex h-9 items-center rounded-lg bg-gold px-3.5 text-sm font-bold text-white transition hover:bg-gold-dark"
                href={"/reservations/bulk/pay?ids=" + reservation.id}
              >
                Record payment
              </Link>
            )}
          {!reservation.archived_at &&
            transitions.map((transition) => (
              <ConfirmAction
                action={transitionReservationStatus.bind(
                  null,
                  reservation.id,
                  transition.to,
                  reservation.updated_at,
                )}
                appearance={
                  transition.destructive
                    ? "compact-danger"
                    : "compact-neutral"
                }
                confirmation={transition.confirmation}
                key={transition.to}
                variant={transition.destructive ? "danger" : "neutral"}
              >
                {transition.to === "cancelled"
                  ? "Cancel"
                  : transition.to === "delivered"
                    ? "Deliver"
                    : transition.label}
              </ConfirmAction>
            ))}
          {isAdmin &&
            !reservation.archived_at &&
            reservation.status === "paid" && (
              <Link
                className="inline-flex h-9 items-center rounded-lg px-3 text-sm font-semibold text-red-700 transition hover:bg-red-50"
                href={"/reservations/bulk/revert?ids=" + reservation.id}
              >
                Revert to Reserved
              </Link>
            )}
        </div>
      </PageHeader>
      <PageNotice error={notices.error} message={notices.message} />
      {!reservation.pricing_complete && (
        <div className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm font-semibold text-amber-900">
          Complete item pricing before recording a payment.
        </div>
      )}

      <div className="mt-7 grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="space-y-6">
          <section className="rounded-3xl border border-border bg-white p-6 shadow-card sm:p-8">
            <div className="grid gap-6 sm:grid-cols-2">
              <InfoItem label="Customer name">
                {customer ? (
                  <Link className="font-semibold text-gold-dark hover:underline" href={"/customers/" + customer.id}>
                    {customer.name}
                  </Link>
                ) : (
                  "Customer unavailable"
                )}
              </InfoItem>
              <InfoItem label="Facebook / CS name">
                {customer?.facebook_name ?? "Not provided"}
              </InfoItem>
              <InfoItem label="Contact">
                {customer?.phone ?? "Not provided"}
              </InfoItem>
              <div className="sm:col-span-2">
                <InfoItem label="Address">
                  <span className="whitespace-pre-wrap">
                    {customer?.address ?? "Not provided"}
                  </span>
                </InfoItem>
              </div>
            </div>
          </section>

          <section className="overflow-hidden rounded-3xl border border-border bg-white shadow-card">
            <div className="border-b border-border px-6 py-5 sm:px-8">
              <div className="flex flex-wrap items-center gap-3">
                <div>
                  <p className="text-xs font-bold uppercase tracking-[0.18em] text-gold-dark">
                    Jewelry items
                  </p>
                  <h2 className="mt-1 font-serif text-2xl text-ink">
                    {items?.length ?? 0} reserved {items?.length === 1 ? "piece" : "pieces"}
                  </h2>
                </div>
                <div className="ml-auto">
                  <ReleaseStatusBadge status={releaseStatus} />
                </div>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1000px] border-collapse text-left">
                <thead className="bg-canvas text-[11px] uppercase tracking-[0.14em] text-muted">
                  <tr>
                    <th className="px-6 py-4 font-bold">Item</th>
                    <th className="px-5 py-4 font-bold">Order date</th>
                    <th className="px-5 py-4 font-bold">Unit price</th>
                    <th className="px-5 py-4 font-bold">Quantity</th>
                    <th className="px-5 py-4 font-bold">Discount</th>
                    <th className="px-6 py-4 text-right font-bold">Line total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {items?.map((item) => {
                    return (
                      <tr key={item.id}>
                        <td className="px-6 py-4">
                          <div className="flex items-center gap-3">
                            <StockImage alt={item.item_name} url={getStockImageUrl(item.image_path)} />
                            <span className="font-semibold text-ink">{item.item_name}</span>
                          </div>
                        </td>
                        <td className="whitespace-nowrap px-5 py-4 text-sm text-ink">
                          <OrderDateEditor
                            canEdit={isAdmin}
                            orderedAt={item.ordered_at}
                            reservationId={reservation.id}
                            reservationItemId={item.id}
                          />
                        </td>
                        <td className="whitespace-nowrap px-5 py-4 text-sm text-ink">{formatCurrency(Number(item.unit_price))}</td>
                        <td className="px-5 py-4 text-sm font-semibold text-ink">{item.quantity}</td>
                        <td className="whitespace-nowrap px-5 py-4 text-sm text-muted">{formatCurrency(Number(item.discount))}</td>
                        <td className="whitespace-nowrap px-6 py-4 text-right text-sm font-bold text-ink">{formatCurrency(Number(item.line_total))}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <ShippingPanel
            canShip={canShip}
            canWrite={canWrite}
            downpayment={displayedPaidAmount}
            isAdmin={isAdmin}
            items={shippingItems}
            reservationId={reservation.id}
            reservationNo={reservation.reservation_no}
            reservedDownpayment={reservedDownpayment}
            shipments={shipmentRows}
            usedDownpayment={usedDownpayment}
          />

          <section className="rounded-3xl border border-border bg-white p-6 shadow-card sm:p-8">
            <InfoItem label="Reservation notes">
              <span className="whitespace-pre-wrap">
                {reservation.notes ?? "No notes recorded."}
              </span>
            </InfoItem>
          </section>

          <section className="rounded-3xl border border-border bg-white p-6 shadow-card sm:p-8">
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-gold-dark">
              Payments
            </p>
            <h2 className="mt-1 font-serif text-2xl text-ink">Payment records</h2>
            {payments?.length ? (
              <div className="mt-6 space-y-4">
                {payments.map((payment) => {
                  const normalizedEvidence = evidenceByPayment.get(payment.id) ?? [];
                  const evidenceItems = normalizedEvidence.length
                    ? normalizedEvidence.flatMap((evidence, index) => {
                        const url = getPaymentEvidenceUrl(evidence.storage_path);
                        return url
                          ? [{
                              alt:
                                "Payment evidence " +
                                (index + 1) +
                                " for " +
                                reservation.reservation_no,
                              url,
                            }]
                          : [];
                      })
                    : payment.evidence_path
                      ? [{
                          alt: "Payment evidence for " + reservation.reservation_no,
                          url: getPaymentEvidenceUrl(payment.evidence_path),
                        }].filter(
                          (item): item is { alt: string; url: string } => Boolean(item.url),
                        )
                      : [];
                  return (
                    <article
                      className={
                        "rounded-2xl border p-5 " +
                        (payment.voided_at
                          ? "border-red-200 bg-red-50/50"
                          : "border-border bg-canvas/50")
                      }
                      key={payment.id}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-4">
                        <div>
                          <p className="text-lg font-black text-ink">
                            {formatCurrency(Number(payment.amount))}
                          </p>
                        </div>
                        {payment.voided_at && (
                          <span className="rounded-full bg-red-100 px-3 py-1 text-xs font-bold text-red-800">
                            Voided
                          </span>
                        )}
                      </div>
                      <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-2">
                        <RecordItem label="Date/time" value={formatDateTime(payment.recorded_at)} />
                        <RecordItem
                          label="Recorded by"
                          value={
                            payment.recorded_by
                              ? paymentNames.get(payment.recorded_by) ?? "Team member"
                              : "Former team member"
                          }
                        />
                        <RecordItem label="Method" value={payment.payment_method ?? "Not provided"} />
                        <RecordItem label="Reference number" value={payment.reference_no ?? "Not provided"} />
                        <RecordItem label="Notes" value={payment.notes ?? "No notes"} />
                        {payment.voided_at && (
                          <RecordItem
                            label="Void audit"
                            value={
                              formatDateTime(payment.voided_at) +
                              " · " +
                              (payment.void_reason ?? "No reason")
                            }
                          />
                        )}
                      </dl>
                      <div className="mt-4">
                        <p className="mb-2 text-xs text-muted">Payment evidence</p>
                        {evidenceItems.length > 0 ? (
                          <PaymentEvidenceViewer items={evidenceItems} />
                        ) : (
                          <p className="text-sm font-semibold text-ink">No evidence attached</p>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : (
              <p className="mt-5 text-sm text-muted">No payment records yet.</p>
            )}
          </section>

          <section className="rounded-3xl border border-border bg-white p-6 shadow-card sm:p-8">
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-gold-dark">
              Status history
            </p>
            <h2 className="mt-1 font-serif text-2xl text-ink">
              Reservation timeline
            </h2>
            {statusHistory?.length ? (
              <ol className="mt-6 space-y-5 border-l border-gold/30 pl-5">
                {statusHistory.map((entry) => (
                  <li className="relative" key={entry.id}>
                    <span className="absolute -left-[1.55rem] top-1.5 size-2.5 rounded-full border-2 border-white bg-gold" />
                    <p className="text-sm font-bold capitalize text-ink">
                      {entry.new_status}
                    </p>
                    {entry.reason && (
                      <p className="mt-1 text-xs text-muted">{entry.reason}</p>
                    )}
                    <p className="mt-1 text-xs text-muted">
                      {formatDateTime(entry.changed_at)} · {entry.changed_by_name ?? "Team member"}
                    </p>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="mt-5 text-sm text-muted">
                No status history is available yet.
              </p>
            )}
          </section>
        </div>

        <aside className="h-fit rounded-3xl border border-border bg-white p-6 shadow-card">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-muted">
              Summary
            </p>
            <ReservationStatus
              archived={Boolean(reservation.archived_at)}
              delivered={Boolean(reservation.delivered_at)}
              status={reservation.status}
            />
          </div>
          <dl className="mt-6 space-y-4 text-sm">
            <SummaryTextRow label="Reservation number" value={reservation.reservation_no} />
            <SummaryTextRow label="Customer name" value={customer?.name ?? "Unavailable"} />
            {customer?.facebook_name && (
              <SummaryTextRow label="Facebook / CS" value={customer.facebook_name} />
            )}
            <SummaryTextRow label="Quantity" value={String(items?.length ?? 0)} />
            <MoneyRow label="Subtotal" value={reservation.subtotal} />
            <MoneyRow label="Reservation discount" value={reservation.discount} />
            <MoneyRow label="Total" strong value={reservation.total} />
            <MoneyRow label="Total Paid" value={displayedPaidAmount} />
            <MoneyRow label="Remaining Balance" strong value={reservation.balance} />
            {reservation.status === "reserved" &&
              displayedPaidAmount > 0 &&
              Number(reservation.balance) > 0 && (
                <div className="flex justify-end">
                  <span className="rounded-full bg-sky-50 px-3 py-1 text-xs font-bold text-sky-700">
                    Partially Paid
                  </span>
                </div>
              )}
          </dl>
          {displayedPaidAmount > 0 && (
            <dl className="mt-5 space-y-3 rounded-2xl border border-border bg-canvas/40 p-4 text-sm">
              <div className="flex items-center justify-between gap-3">
                <dt className="text-xs font-bold uppercase tracking-[0.15em] text-muted">
                  Downpayment breakdown
                </dt>
                <ReleaseStatusBadge status={releaseStatus} />
              </div>
              <MoneyRow label="Used on releases" value={usedDownpayment} />
              {reservedDownpayment > 0 && (
                <MoneyRow
                  label="Reserved by open release"
                  value={reservedDownpayment}
                />
              )}
              <MoneyRow
                label="Remaining unapplied"
                strong
                value={Math.max(
                  displayedPaidAmount -
                    usedDownpayment -
                    reservedDownpayment,
                  0,
                )}
              />
            </dl>
          )}
          <dl className="mt-6 space-y-5 border-t border-border pt-6">
            <RecordItem label="Reserved at" value={formatDateTime(reservation.reserved_at)} />
            {reservation.paid_at && <RecordItem label="Paid at" value={formatDateTime(reservation.paid_at)} />}
            {reservation.delivered_at && <RecordItem label="Delivered at" value={formatDateTime(reservation.delivered_at)} />}
            {reservation.cancelled_at && <RecordItem label="Cancelled at" value={formatDateTime(reservation.cancelled_at)} />}
            <RecordItem label="Created by" value={createdBy} />
            <RecordItem label="Created at" value={formatDateTime(reservation.created_at)} />
            <RecordItem label="Last updated" value={formatDateTime(reservation.updated_at)} />
          </dl>
          {isAdmin && (
            <div className="mt-6 border-t border-border pt-5">
              {reservation.archived_at ? (
                <ConfirmAction action={restoreReservation.bind(null, reservation.id)} confirmation={"Restore " + reservation.reservation_no + " to the active list?"} variant="neutral">
                  Restore reservation
                </ConfirmAction>
              ) : (
                <ConfirmAction action={archiveReservation.bind(null, reservation.id)} confirmation={"Archive " + reservation.reservation_no + "? Its business status and stock commitment will remain unchanged."}>
                  Archive reservation
                </ConfirmAction>
              )}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function InfoItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs font-bold uppercase tracking-[0.15em] text-muted">{label}</p>
      <div className="mt-2 text-sm leading-7 text-ink">{children}</div>
    </div>
  );
}

function MoneyRow({ label, value, strong = false }: { label: string; value: number; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className={strong ? "font-bold text-ink" : "text-muted"}>{label}</dt>
      <dd className={strong ? "font-bold text-ink" : "font-semibold text-ink"}>{formatCurrency(Number(value))}</dd>
    </div>
  );
}

function SummaryTextRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <dt className="text-muted">{label}</dt>
      <dd className="max-w-[170px] text-right font-semibold text-ink">{value}</dd>
    </div>
  );
}

function RecordItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-1 text-sm font-semibold text-ink">{value}</dd>
    </div>
  );
}
