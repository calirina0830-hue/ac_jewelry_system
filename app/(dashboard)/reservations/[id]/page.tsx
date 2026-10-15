import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import {
  archiveReservation,
  restoreReservation,
  transitionReservationStatus,
} from "@/actions/reservations";
import { deleteReservationPayment } from "@/actions/payments";
import { OrderDateEditor } from "@/components/reservations/order-date-editor";
import { EditPaymentRecord } from "@/components/reservations/edit-payment-record";
import {
  PaymentEditHistory,
  type PaymentEditHistoryEntry,
} from "@/components/reservations/payment-edit-history";
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
import { calculatePaymentTransactionSummary } from "@/lib/reservations/payment-transaction";
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
  searchParams: Promise<{ message?: string; error?: string; view?: string }>;
}) {
  const { id } = await params;
  const notices = await searchParams;
  const isDeliveredView = notices.view === "delivered";
  const parsedId = reservationIdSchema.safeParse(id);

  if (!parsedId.success) {
    notFound();
  }

  const [profile, supabase] = await Promise.all([
    getCurrentProfile(),
    createClient(),
  ]);
  const canWrite = roleCanWrite(profile?.role);
  const isAdmin = roleIsAdmin(profile?.role);
  const { data: reservation } = await supabase
    .from("reservations")
    .select("*")
    .eq("id", parsedId.data)
    .maybeSingle();

  if (!reservation) {
    notFound();
  }
  const canManagePaymentRecords =
    canWrite &&
    !isDeliveredView &&
    !reservation.archived_at &&
    (reservation.status === "reserved" || reservation.status === "paid");

  const [
    { data: customer },
    { data: items },
    { data: statusHistory },
    { data: payments },
    { data: shipments },
    { data: creator },
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
    supabase
      .from("reservation_shipments")
      .select("id, shipment_no, status, created_at, shipped_at, downpayment_applied, notes, cancel_reason")
      .eq("reservation_id", reservation.id)
      .order("created_at", { ascending: false }),
    reservation.created_by
      ? supabase
          .from("profiles")
          .select("full_name")
          .eq("id", reservation.created_by)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const shipmentIds = (shipments ?? []).map((shipment) => shipment.id);
  const paymentIds = (payments ?? []).map((payment) => payment.id);
  const paymentUserIds = [
    ...new Set(
      (payments ?? []).flatMap((payment) =>
        [payment.recorded_by, payment.voided_by].filter(
          (value): value is string => Boolean(value),
        ),
      ),
    ),
  ];
  const [shipmentItemsResult, paymentEvidenceResult, paymentProfilesResult] =
    await Promise.all([
      shipmentIds.length
        ? supabase
            .from("reservation_shipment_items")
            .select("shipment_id, reservation_item_id, quantity")
            .in("shipment_id", shipmentIds)
        : Promise.resolve({ data: [] }),
      supabase
        .from("reservation_payment_evidence")
        .select("*")
        .in(
          "payment_id",
          paymentIds.length
            ? paymentIds
            : ["00000000-0000-0000-0000-000000000000"],
        )
        .order("created_at"),
      paymentUserIds.length
        ? supabase
            .from("profiles")
            .select("id, full_name")
            .in("id", paymentUserIds)
        : Promise.resolve({ data: [] }),
    ]);
  const shipmentItems = shipmentItemsResult.data;
  const paymentEvidence = paymentEvidenceResult.data;
  const paymentProfiles = paymentProfilesResult.data;
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
  const remainingItems = (items ?? [])
    .map((item) => {
      const shippedQty = shippedByItem.get(item.id) ?? 0;
      const remainingQty = Math.max(Number(item.quantity) - shippedQty, 0);
      const unitPrice = Number(item.unit_price);
      const discount = Number(item.discount ?? 0);
      const lineDiscount = Number(item.quantity) > 0 ? (discount * remainingQty) / Number(item.quantity) : 0;
      const lineTotal = Math.max(unitPrice * remainingQty - lineDiscount, 0);
      return {
        ...item,
        remainingQty,
        shippedQty,
        remainingLineTotal: lineTotal,
      };
    })
    .filter((item) => item.remainingQty > 0);
  const hasShippedRecords = (shipments ?? []).some(
    (shipment) => shipment.status === "shipped",
  );
  const deliveredItems = (items ?? [])
    .map((item) => {
      const originalQty = Number(item.quantity);
      const deliveredQty = Math.min(
        shippedByItem.get(item.id) ??
          (reservation.status === "delivered" && !hasShippedRecords
            ? originalQty
            : 0),
        originalQty,
      );
      const itemDiscount = Number(item.discount ?? 0);
      const deliveredDiscount = originalQty > 0
        ? (itemDiscount * deliveredQty) / originalQty
        : 0;
      return {
        ...item,
        displayQuantity: deliveredQty,
        displayDiscount: deliveredDiscount,
        displayLineTotal: Math.max(
          Number(item.unit_price) * deliveredQty - deliveredDiscount,
          0,
        ),
      };
    })
    .filter((item) => item.displayQuantity > 0);
  const displayedItems = isDeliveredView
    ? deliveredItems
    : remainingItems.map((item) => ({
        ...item,
        displayQuantity: item.remainingQty,
        displayDiscount: Number(item.discount ?? 0),
        displayLineTotal: item.remainingLineTotal,
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
  const originalGrossTotal = (items ?? []).reduce(
    (total, item) => total + Number(item.unit_price) * Number(item.quantity),
    0,
  );
  const deliveredGrossTotal = deliveredItems.reduce(
    (total, item) => total + Number(item.unit_price) * item.displayQuantity,
    0,
  );
  const deliveredItemSubtotal = deliveredItems.reduce(
    (total, item) => total + item.displayLineTotal,
    0,
  );
  const deliveredReservationDiscount = originalGrossTotal > 0
    ? Number(reservation.discount) * (deliveredGrossTotal / originalGrossTotal)
    : 0;
  const deliveredSubtotal = Math.max(
    deliveredItemSubtotal - deliveredReservationDiscount,
    0,
  );
  const deliveredBalance = Math.max(deliveredSubtotal - usedDownpayment, 0);
  const deliveredQuantity = deliveredItems.reduce(
    (total, item) => total + item.displayQuantity,
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
  const evidenceByPayment = new Map<string, NonNullable<typeof paymentEvidence>>();
  for (const evidence of paymentEvidence ?? []) {
    evidenceByPayment.set(evidence.payment_id, [
      ...(evidenceByPayment.get(evidence.payment_id) ?? []),
      evidence,
    ]);
  }
  const createdBy = reservation.created_by
    ? creator?.full_name ?? "User " + reservation.created_by.slice(0, 8)
    : "Former team member";
  const paymentNames = new Map(
    (paymentProfiles ?? []).map((entry) => [entry.id, entry.full_name]),
  );
  const paymentById = new Map(
    (payments ?? []).map((payment) => [payment.id, payment]),
  );
  const previousPaymentByReplacementId = new Map<
    string,
    NonNullable<typeof payments>[number]
  >();
  for (const payment of payments ?? []) {
    const replacementId = payment.void_reason?.match(
      /^Edited and replaced by payment ([0-9a-f-]{36})\.$/i,
    )?.[1];
    if (replacementId && paymentById.has(replacementId)) {
      previousPaymentByReplacementId.set(replacementId, payment);
    }
  }
  const paymentEditHistory = new Map<string, PaymentEditHistoryEntry[]>();
  for (const payment of payments ?? []) {
    const history: PaymentEditHistoryEntry[] = [];
    const visited = new Set<string>();
    let currentPayment = payment;
    let previousPayment = previousPaymentByReplacementId.get(currentPayment.id);

    while (previousPayment && !visited.has(previousPayment.id)) {
      visited.add(previousPayment.id);
      history.push({
        previousAmount: Number(previousPayment.amount),
        editedAmount: Number(currentPayment.amount),
        editedAt: previousPayment.voided_at ?? currentPayment.recorded_at,
        editedBy: previousPayment.voided_by
          ? paymentNames.get(previousPayment.voided_by) ?? "Team member"
          : "Former team member",
      });
      currentPayment = previousPayment;
      previousPayment = previousPaymentByReplacementId.get(currentPayment.id);
    }

    if (history.length > 0) {
      paymentEditHistory.set(payment.id, history.reverse());
    }
  }
  const visiblePayments = (payments ?? []).filter(
    (payment) =>
      !payment.void_reason?.startsWith("Edited and replaced by payment "),
  );
  const activePaymentTotal = (payments ?? [])
    .filter((payment) => !payment.voided_at)
    .reduce((total, payment) => total + Number(payment.amount), 0);
  const paymentTransaction = calculatePaymentTransactionSummary({
    originalTotal: Number(reservation.total),
    reservationDiscount: Number(reservation.discount),
    items: (items ?? []).map((item) => ({
      id: item.id,
      sku: item.sku,
      itemName: item.item_name,
      category: item.category,
      quantity: Number(item.quantity),
      unitPrice: Number(item.unit_price),
      discount: Number(item.discount ?? 0),
    })),
    shipments: (shipments ?? []).map((shipment) => ({
      id: shipment.id,
      status: shipment.status,
      downpaymentApplied: Number(shipment.downpayment_applied ?? 0),
    })),
    shipmentItems: (shipmentItems ?? []).map((item) => ({
      shipmentId: item.shipment_id,
      reservationItemId: item.reservation_item_id,
      quantity: Number(item.quantity),
    })),
    payments: (payments ?? [])
      .filter((payment) => !payment.voided_at)
      .map((payment) => Number(payment.amount)),
  });
  const remainingQuantity = paymentTransaction.items.reduce(
    (total, item) => total + item.remainingQuantity,
    0,
  );
  const downpaymentAmount = Number(reservation.downpayment);
  const displayedPaidAmount = isDeliveredView
    ? usedDownpayment
    : activePaymentTotal;
  const combinedSubtotal = paymentTransaction.remainingItemsSubtotal;
  const combinedDiscount = paymentTransaction.remainingReservationDiscount;
  const combinedTotal = paymentTransaction.remainingItemsTotal;
  const combinedBalance = paymentTransaction.remainingBalance;

  return (
    <div className="mx-auto max-w-[1250px] px-5 py-8 sm:px-8 lg:px-10 lg:py-10">
      <PageHeader
        description={
          isDeliveredView
            ? "Customer and item details recorded for delivered goods."
            : "Customer commitment, jewelry snapshots, and server-verified financial totals."
        }
        eyebrow={isDeliveredView ? "Delivered order" : "Reservation details"}
        title={reservation.reservation_no}
      >
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
          <Link
            className="inline-flex h-9 items-center rounded-lg px-2 text-sm font-semibold text-muted transition hover:bg-white hover:text-ink"
            href={isDeliveredView ? "/reservations?status=delivered" : "/reservations"}
          >
            {isDeliveredView ? "← Delivered orders" : "← Reservations"}
          </Link>
          {!isDeliveredView && (
            <Link
              className="inline-flex h-9 items-center rounded-lg border border-border bg-white px-3 text-sm font-semibold text-ink transition hover:border-gold hover:bg-canvas"
              href={"/reservations/" + reservation.id + "/invoice"}
            >
              Invoice
            </Link>
          )}
          {!isDeliveredView && canWrite && !reservation.archived_at && reservation.status === "reserved" && (
            <Link
              className="inline-flex h-9 items-center rounded-lg border border-border bg-white px-3 text-sm font-semibold text-ink transition hover:border-gold hover:bg-canvas"
              href={"/reservations/" + reservation.id + "/edit"}
            >
              {needsReservationPricing(reservation) ? "Complete pricing" : "Edit"}
            </Link>
          )}
          {!isDeliveredView && canWrite && canRecordReservationPayment(reservation) && (
              <Link
                className="relative z-10 inline-flex h-9 items-center rounded-lg bg-gold px-3.5 text-sm font-bold text-white transition hover:bg-gold-dark"
                href={"/reservations/bulk/pay?ids=" + reservation.id}
              >
                Record payment
              </Link>
            )}
          {!isDeliveredView && !reservation.archived_at &&
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
          {!isDeliveredView && isAdmin &&
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
      {!isDeliveredView && !reservation.pricing_complete && (
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
                    {isDeliveredView ? "Delivered items" : "Jewelry items"}
                  </p>
                  <h2 className="mt-1 font-serif text-2xl text-ink">
                    {isDeliveredView
                      ? `${deliveredQuantity} ${deliveredQuantity === 1 ? "piece" : "pieces"} delivered`
                      : `${remainingItems.length} ${remainingItems.length === 1 ? "piece" : "pieces"} on shop`}
                  </h2>
                </div>
                {!isDeliveredView && (
                  <div className="ml-auto">
                    <ReleaseStatusBadge status={releaseStatus} />
                  </div>
                )}
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[950px] border-collapse text-left">
                <thead className="bg-canvas text-[11px] uppercase tracking-[0.14em] text-muted">
                  <tr>
                    <th className="px-6 py-4 font-bold">Item</th>
                    <th className="px-5 py-4 font-bold">Order date</th>
                    <th className="px-5 py-4 font-bold">Unit price</th>
                    <th className="px-5 py-4 font-bold">{isDeliveredView ? "Delivered quantity" : "Quantity"}</th>
                    <th className="px-5 py-4 font-bold">Discount</th>
                    <th className="px-6 py-4 text-right font-bold">Line total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {displayedItems.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-6 py-8 text-center text-sm text-muted">
                        {isDeliveredView
                          ? "No delivered items are recorded for this order."
                          : "All items have been delivered to the customer."}
                      </td>
                    </tr>
                  ) : (
                    displayedItems.map((item) => {
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
                              canEdit={false}
                              orderedAt={item.ordered_at || item.created_at || reservation.reserved_at}
                              reservationId={item.reservation_id ?? reservation.id}
                              reservationItemId={item.id}
                            />
                          </td>
                          <td className="whitespace-nowrap px-5 py-4 text-sm text-ink">{formatCurrency(Number(item.unit_price))}</td>
                          <td className="px-5 py-4 text-sm font-semibold text-ink">{item.displayQuantity}</td>
                          <td className="whitespace-nowrap px-5 py-4 text-sm text-muted">{formatCurrency(item.displayDiscount)}</td>
                          <td className="whitespace-nowrap px-6 py-4 text-right text-sm font-bold text-ink">{formatCurrency(item.displayLineTotal)}</td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
            {isDeliveredView && (
              <DeliveredRecords
                shipments={shipmentRows.filter((shipment) => shipment.status === "shipped")}
              />
            )}
          </section>

          {!isDeliveredView && (
            <ShippingPanel
              canShip={canShip}
              canWrite={canWrite}
              downpayment={downpaymentAmount}
              isAdmin={isAdmin}
              items={shippingItems}
              reservationId={reservation.id}
              reservationNo={reservation.reservation_no}
              reservedDownpayment={reservedDownpayment}
              shipments={shipmentRows}
              usedDownpayment={usedDownpayment}
            />
          )}

          {!isDeliveredView && <section className="rounded-3xl border border-border bg-white p-6 shadow-card sm:p-8">
            <InfoItem label="Reservation notes">
              <span className="whitespace-pre-wrap">
                {reservation.notes ?? "No notes recorded."}
              </span>
            </InfoItem>
          </section>}

          {!isDeliveredView && <section className="rounded-3xl border border-border bg-white p-6 shadow-card sm:p-8">
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-gold-dark">
              Payments
            </p>
            <h2 className="mt-1 font-serif text-2xl text-ink">Payment and downpayment details</h2>
            <dl className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <PaymentSummaryCard
                label="Total received"
                value={activePaymentTotal}
              />
              <PaymentSummaryCard
                label="Downpayment"
                value={downpaymentAmount}
              />
              <PaymentSummaryCard
                label="Applied to releases"
                value={usedDownpayment}
              />
              <PaymentSummaryCard
                label="Open release hold"
                value={reservedDownpayment}
              />
              <PaymentSummaryCard
                label="Available downpayment"
                value={Math.max(
                  downpaymentAmount - usedDownpayment - reservedDownpayment,
                  0,
                )}
              />
            </dl>
            <h3 className="mt-8 font-serif text-xl text-ink">Payment records</h3>
            {visiblePayments.length ? (
              <div className="mt-6 space-y-4">
                {visiblePayments.map((payment) => {
                  const editHistory = paymentEditHistory.get(payment.id) ?? [];
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
                        <div className="flex flex-wrap items-center gap-2">
                          {payment.voided_at && (
                            <span className="rounded-full bg-red-100 px-3 py-1 text-xs font-bold text-red-800">
                              Voided
                            </span>
                          )}
                          {editHistory.length > 0 && (
                            <PaymentEditHistory entries={editHistory} />
                          )}
                          {canManagePaymentRecords && !payment.voided_at && (
                            <>
                              <EditPaymentRecord
                                paymentId={payment.id}
                                reservationId={reservation.id}
                                reservationUpdatedAt={reservation.updated_at}
                                paymentRecordedAt={payment.recorded_at}
                                amount={Number(payment.amount)}
                                paymentMethod={payment.payment_method}
                                referenceNo={payment.reference_no}
                                notes={payment.notes}
                              />
                              <ConfirmAction
                                action={deleteReservationPayment.bind(
                                  null,
                                  payment.id,
                                  reservation.id,
                                  payment.recorded_at,
                                  reservation.updated_at,
                                )}
                                appearance="compact-danger"
                                confirmation={
                                  "Remove this payment from active totals? Its record and evidence will remain in the audit history, and the reservation balance may increase."
                                }
                              >
                                Delete
                              </ConfirmAction>
                            </>
                          )}
                        </div>
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
          </section>}

          {!isDeliveredView && <section className="rounded-3xl border border-border bg-white p-6 shadow-card sm:p-8">
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
          </section>}
        </div>

        <aside className="h-fit rounded-3xl border border-border bg-white p-6 shadow-card">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-muted">
              Summary
            </p>
            <ReservationStatus
              archived={Boolean(reservation.archived_at)}
              delivered={isDeliveredView ? undefined : Boolean(reservation.delivered_at)}
              status={isDeliveredView ? "delivered" : reservation.status}
            />
          </div>
          <dl className="mt-6 space-y-4 text-sm">
            <SummaryTextRow label="Reservation number" value={reservation.reservation_no} />
            <SummaryTextRow label="Customer name" value={customer?.name ?? "Unavailable"} />
            {customer?.facebook_name && (
              <SummaryTextRow label="Facebook / CS" value={customer.facebook_name} />
            )}
            <SummaryTextRow
              label={isDeliveredView ? "Delivered quantity" : "Quantity"}
              value={String(isDeliveredView ? deliveredQuantity : remainingQuantity)}
            />
            <MoneyRow
              label={isDeliveredView ? "Delivered item subtotal" : "Subtotal"}
              value={isDeliveredView ? deliveredItemSubtotal : combinedSubtotal}
            />
            <MoneyRow
              label={isDeliveredView ? "Allocated reservation discount" : "Reservation discount"}
              value={isDeliveredView ? deliveredReservationDiscount : combinedDiscount}
            />
            <MoneyRow
              label={isDeliveredView ? "Delivered total" : "Total"}
              strong
              value={isDeliveredView ? deliveredSubtotal : combinedTotal}
            />
            <MoneyRow
              label={isDeliveredView ? "Downpayment applied" : "Total Paid"}
              value={displayedPaidAmount}
            />
            <MoneyRow
              label={isDeliveredView ? "Balance on delivered items" : "Remaining Balance"}
              strong
              value={isDeliveredView ? deliveredBalance : combinedBalance}
            />
            {!isDeliveredView && reservation.status === "reserved" &&
              displayedPaidAmount > 0 &&
              Number(combinedBalance) > 0 && (
                <div className="flex justify-end">
                  <span className="rounded-full bg-sky-50 px-3 py-1 text-xs font-bold text-sky-700">
                    Partially Paid
                  </span>
                </div>
              )}
          </dl>
          {!isDeliveredView && activePaymentTotal > 0 && (
            <dl className="mt-5 space-y-3 rounded-2xl border border-border bg-canvas/40 p-4 text-sm">
              <div className="flex items-center justify-between gap-3">
                <dt className="text-xs font-bold uppercase tracking-[0.15em] text-muted">
                  Payment breakdown
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
                  activePaymentTotal -
                    usedDownpayment -
                    reservedDownpayment,
                  0,
                )}
              />
            </dl>
          )}
          {!isDeliveredView && <dl className="mt-6 space-y-5 border-t border-border pt-6">
            <RecordItem label="Reserved at" value={formatDateTime(reservation.reserved_at)} />
            {reservation.paid_at && <RecordItem label="Paid at" value={formatDateTime(reservation.paid_at)} />}
            {reservation.delivered_at && <RecordItem label="Delivered at" value={formatDateTime(reservation.delivered_at)} />}
            {reservation.cancelled_at && <RecordItem label="Cancelled at" value={formatDateTime(reservation.cancelled_at)} />}
            <RecordItem label="Created by" value={createdBy} />
            <RecordItem label="Created at" value={formatDateTime(reservation.created_at)} />
            <RecordItem label="Last updated" value={formatDateTime(reservation.updated_at)} />
          </dl>}
          {!isDeliveredView && isAdmin && (
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

function DeliveredRecords({
  shipments,
}: {
  shipments: Array<{
    id: string;
    shipmentNo: string;
    createdAt: string;
    shippedAt: string | null;
    totalQuantity: number;
    downpaymentApplied: number;
  }>;
}) {
  return (
    <div className="border-t border-border px-6 py-5 sm:px-8">
      <p className="text-xs font-bold uppercase tracking-[0.18em] text-gold-dark">
        Deliveries
      </p>
      <h2 className="mt-1 font-serif text-2xl text-ink">Delivery records</h2>
      {shipments.length ? (
        <div className="mt-5 space-y-3">
          {shipments.map((shipment) => (
            <div
              className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-border bg-canvas/50 p-4"
              key={shipment.id}
            >
              <div>
                <p className="font-bold text-ink">{shipment.shipmentNo}</p>
                <p className="mt-1 text-sm text-muted">
                  {shipment.totalQuantity} delivered unit{shipment.totalQuantity === 1 ? "" : "s"}
                  {" · "}
                  {formatDateTime(shipment.shippedAt ?? shipment.createdAt)}
                </p>
                <p className="mt-1 text-sm font-semibold text-ink">
                  Downpayment applied: {formatCurrency(shipment.downpaymentApplied)}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-4">
                <Link
                  className="text-sm font-bold text-gold-dark hover:underline"
                  href={"/shipments/" + shipment.id + "/pdf?view=inline"}
                  rel="noreferrer"
                  target="_blank"
                >
                  View invoice
                </Link>
                <Link
                  className="text-sm font-bold text-gold-dark hover:underline"
                  href={"/shipments/" + shipment.id + "/pdf"}
                >
                  Download PDF
                </Link>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-5 text-sm text-muted">
          This order was marked delivered without item-level delivery records.
        </p>
      )}
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

function PaymentSummaryCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-2xl border border-border bg-canvas/50 p-4">
      <dt className="text-xs font-semibold text-muted">{label}</dt>
      <dd className="mt-1 text-base font-black text-ink">
        {formatCurrency(value)}
      </dd>
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
