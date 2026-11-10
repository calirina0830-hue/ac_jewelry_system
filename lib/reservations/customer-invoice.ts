import {
  computeCycleTotals,
  selectBillableOrders,
  selectCurrentCycle,
  type CycleOrderAmounts,
} from "@/lib/reservations/customer-cycle";
import {
  getInvoiceStatusLabel,
  getInvoiceTotals,
} from "@/lib/reservations/invoice";
import { formatItemLabel } from "@/lib/reservations/item-label";
import { computeReleaseLedger } from "@/lib/reservations/release";
import type { createClient } from "@/lib/supabase/server";
import type { ReservationStatus } from "@/types/database";
import type {
  CustomerInvoiceEditor,
  CustomerInvoiceItem,
} from "@/types/reservations";

type SupabaseClient = Awaited<ReturnType<typeof createClient>>;

type CustomerInvoiceShipmentLine = {
  shipment_id: string;
  reservation_item_id: string;
  quantity: number;
};

export type CustomerInvoice = {
  customerName: string;
  facebookName: string | null;
  phone: string | null;
  address: string | null;
  notes: string | null;
  invoiceDate: string | null;
  statusLabel: string;
  delivered: boolean;
  items: CustomerInvoiceItem[];
  totals: {
    subtotal: number;
    discount: number;
    total: number;
    quantity: number;
    amountPaid: number;
    downpayment: number;
    balance: number;
  };
  // Confirmed releases in the current computation, each with its own PDF.
  releases: Array<{ id: string; shipmentNo: string }>;
  // The most that new releases can still deduct.
  availableDownpayment: number;
  // Downpayment not yet used by a confirmed release.
  unappliedDownpayment: number;
  editor: CustomerInvoiceEditor | null;
  // Active Reserved reservations that still have items on this invoice.
  editableReservations: Array<{
    id: string;
    needsPricing: boolean;
  }>;
  // Every reservation on this invoice, for status moves in the panel.
  reservations: Array<{
    id: string;
    status: ReservationStatus;
    updatedAt: string;
    archived: boolean;
    balance: number;
    pricingComplete: boolean;
    // What this reservation contributes to the invoice totals.
    remainingGross: number;
    remainingDiscount: number;
  }>;
  // Releases that were prepared but never confirmed, one entry per release.
  pendingReleases: Array<{
    shipmentId: string;
    reservationId: string;
    itemLabels: string[];
  }>;
};

function normalizeCustomerName(value: string | null | undefined) {
  return (value ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase();
}

export async function loadCustomerInvoice(
  supabase: SupabaseClient,
  customerName: string,
): Promise<CustomerInvoice | null> {
  const normalizedTarget = normalizeCustomerName(customerName);
  if (!normalizedTarget) return null;

  // Round trip 1: let the database narrow the search to names containing the
  // same words (case-insensitive), then keep only exact matches after the
  // same normalization the list page uses for grouping.
  const namePattern =
    "%" +
    normalizedTarget
      .split(" ")
      .map((word) => word.replace(/[\\%_]/g, "\\$&"))
      .join("%") +
    "%";
  const { data: candidates } = await supabase
    .from("reservation_list")
    .select("id, customer_id, customer_name, customer_facebook_name, customer_phone")
    .ilike("customer_name", namePattern)
    .limit(500);

  const matchingCandidates = (candidates ?? []).filter(
    (candidate) => normalizeCustomerName(candidate.customer_name) === normalizedTarget,
  );
  const reservationIds = matchingCandidates.map((candidate) => candidate.id);
  if (!reservationIds.length) return null;
  const candidateCustomerIds = [
    ...new Set(matchingCandidates.map((candidate) => candidate.customer_id)),
  ];

  // Round trip 2: everything else at once. Release lines come embedded in
  // their releases instead of needing a third request.
  const [
    { data: allReservations },
    { data: items },
    { data: payments },
    { data: shipments },
    { data: customers },
  ] = await Promise.all([
    supabase
      .from("reservations")
      .select(
        "id, customer_id, status, subtotal, discount, downpayment, total, balance, pricing_complete, notes, reserved_at, delivered_at, archived_at, updated_at, created_at",
      )
      .in("id", reservationIds)
      .order("reserved_at", { ascending: false }),
    supabase
      .from("reservation_items")
      .select(
        "id, reservation_id, stock_item_id, sku, item_name, category, quantity, unit_price, discount, line_total, ordered_at, created_at",
      )
      .in("reservation_id", reservationIds)
      .order("ordered_at", { ascending: true })
      .order("created_at", { ascending: true }),
    supabase
      .from("reservation_payments")
      .select("reservation_id, amount, voided_at")
      .in("reservation_id", reservationIds),
    supabase
      .from("reservation_shipments")
      .select(
        "id, shipment_no, reservation_id, status, downpayment_applied, created_at, reservation_shipment_items(shipment_id, reservation_item_id, quantity)",
      )
      .in("reservation_id", reservationIds),
    supabase
      .from("customers")
      .select("id, name, facebook_name, phone, address")
      .in("id", candidateCustomerIds),
  ]);

  if (!allReservations || !items) return null;

  const shipmentItems = (shipments ?? []).flatMap(
    (shipment) => shipment.reservation_shipment_items ?? [],
  );

  const itemsByReservation = new Map<string, typeof items>();
  for (const item of items) {
    const existing = itemsByReservation.get(item.reservation_id);
    if (existing) existing.push(item);
    else itemsByReservation.set(item.reservation_id, [item]);
  }

  const shipmentsByReservation = new Map<string, typeof shipments>();
  for (const shipment of shipments ?? []) {
    const existing = shipmentsByReservation.get(shipment.reservation_id);
    if (existing) existing.push(shipment);
    else shipmentsByReservation.set(shipment.reservation_id, [shipment]);
  }

  const shipmentLinesByShipment = new Map<
    string,
    CustomerInvoiceShipmentLine[]
  >();
  for (const line of shipmentItems ?? []) {
    const existing = shipmentLinesByShipment.get(line.shipment_id);
    const normalizedLine = {
      shipment_id: line.shipment_id,
      reservation_item_id: line.reservation_item_id,
      quantity: Number(line.quantity),
    } satisfies CustomerInvoiceShipmentLine;
    if (existing) existing.push(normalizedLine);
    else shipmentLinesByShipment.set(line.shipment_id, [normalizedLine]);
  }

  const activePaidByReservation = new Map<string, number>();
  for (const payment of payments ?? []) {
    if (payment.voided_at) continue;
    activePaidByReservation.set(
      payment.reservation_id,
      (activePaidByReservation.get(payment.reservation_id) ?? 0) +
        Number(payment.amount),
    );
  }

  // Only confirmed releases take items off the invoice, matching the
  // reservations list. A pending (prepared, unconfirmed) release keeps its
  // items here, flagged, so the invoice and the list always agree.
  const shippedOf = (reservationId: string) =>
    (shipmentsByReservation.get(reservationId) ?? []).filter(
      (shipment) => shipment.status === "shipped",
    );
  const ledgersByReservation = new Map(
    allReservations.map((reservation) => {
      const shipped = shippedOf(reservation.id);
      return [
        reservation.id,
        computeReleaseLedger(
          (itemsByReservation.get(reservation.id) ?? []).map((item) => ({
            id: item.id,
            description: formatItemLabel({ sku: item.sku, name: item.item_name, category: item.category }),
            quantity: Number(item.quantity),
            unitPrice: Number(item.unit_price),
            discount: Number(item.discount ?? 0),
          })),
          shipped.map((shipment) => ({
            id: shipment.id,
            status: shipment.status,
            downpayment_applied: Number(shipment.downpayment_applied ?? 0),
          })),
          shipped.flatMap((shipment) =>
            (shipmentLinesByShipment.get(shipment.id) ?? []).map((line) => ({
              shipment_id: shipment.id,
              reservation_item_id: line.reservation_item_id,
              quantity: Number(line.quantity),
            })),
          ),
        ),
      ] as const;
    }),
  );

  const activeReservations = selectBillableOrders(
    allReservations,
    (id) => shippedOf(id).length > 0,
    (id) => (ledgersByReservation.get(id)?.remainingUnits ?? 0) > 0,
  );

  // Orders from a computation that already finished stay out of this invoice.
  const currentCycleIds = new Set(
    selectCurrentCycle(
      activeReservations.map((reservation) => ({
        id: reservation.id,
        createdAt: reservation.created_at,
        remainingUnits: ledgersByReservation.get(reservation.id)?.remainingUnits ?? 0,
        lastReleaseAt:
          shippedOf(reservation.id)
            .map((shipment) => shipment.created_at)
            .sort()
            .at(-1) ?? null,
      })),
    ).map((order) => order.id),
  );
  const reservations = activeReservations.filter((reservation) =>
    currentCycleIds.has(reservation.id),
  );

  const documentItems: CustomerInvoiceItem[] = [];
  let subtotal = 0;
  let discount = 0;
  let total = 0;
  let quantity = 0;
  let downpayment = 0;
  const cycleOrders: CycleOrderAmounts[] = [];
  const invoiceAmountsByReservation = new Map<
    string,
    { remainingGross: number; remainingDiscount: number }
  >();
  const editorReservations: Array<{
    reservation: (typeof reservations)[number];
    items: CustomerInvoiceEditor["items"];
  }> = [];
  const editableReservations: CustomerInvoice["editableReservations"] = [];
  const pendingReleases = new Map<
    string,
    CustomerInvoice["pendingReleases"][number]
  >();

  for (const reservation of reservations) {
    const reservationItems = itemsByReservation.get(reservation.id) ?? [];
    const allShipments = shipmentsByReservation.get(reservation.id) ?? [];
    const pendingByItem = new Map<string, { shipmentId: string; quantity: number }>();
    for (const shipment of allShipments) {
      if (shipment.status !== "pending") continue;
      for (const line of shipmentLinesByShipment.get(shipment.id) ?? []) {
        const existing = pendingByItem.get(line.reservation_item_id);
        pendingByItem.set(line.reservation_item_id, {
          shipmentId: existing?.shipmentId ?? shipment.id,
          quantity: (existing?.quantity ?? 0) + line.quantity,
        });
      }
    }
    const ledger = ledgersByReservation.get(reservation.id);
    if (!ledger) continue;
    const itemById = new Map(reservationItems.map((item) => [item.id, item]));
    const grossTotal = ledger.items.reduce((sum, item) => sum + item.grossValue, 0);
    const grossRemaining = ledger.items.reduce(
      (sum, item) => sum + item.unitPrice * item.remainingQty,
      0,
    );
    const remainingFraction = grossTotal > 0 ? grossRemaining / grossTotal : 0;
    const reservationDiscount = Number(reservation.discount) * remainingFraction;
    const remainingTotal = Math.max(
      ledger.remainingSubtotal - reservationDiscount,
      0,
    );
    const paid = activePaidByReservation.get(reservation.id) ?? 0;
    const reservationTotals = getInvoiceTotals(reservation, paid);
    invoiceAmountsByReservation.set(reservation.id, {
      remainingGross: grossRemaining,
      remainingDiscount: reservationDiscount,
    });
    cycleOrders.push({
      remainingTotal,
      releasedTotal: Math.max(
        ledger.releasedSubtotal - (Number(reservation.discount) - reservationDiscount),
        0,
      ),
      paid: reservationTotals.amountPaid,
      appliedShipped: ledger.downpaymentCommitted,
      appliedPending: allShipments
        .filter((shipment) => shipment.status === "pending")
        .reduce((sum, shipment) => sum + Number(shipment.downpayment_applied ?? 0), 0),
    });

    subtotal += ledger.remainingSubtotal;
    discount += reservationDiscount;
    total += remainingTotal;
    quantity += ledger.remainingUnits;
    downpayment += Number(reservation.downpayment);

    const editableItems = [] as CustomerInvoiceEditor["items"];
    for (const ledgerItem of ledger.items) {
      if (ledgerItem.remainingQty <= 0) continue;
      const item = itemById.get(ledgerItem.id);
      if (!item) continue;
      const orderedAt = item.ordered_at ?? item.created_at ?? reservation.reserved_at;
      const pendingRelease = pendingByItem.get(item.id) ?? null;
      if (pendingRelease) {
        const entry = pendingReleases.get(pendingRelease.shipmentId) ?? {
          shipmentId: pendingRelease.shipmentId,
          reservationId: reservation.id,
          itemLabels: [],
        };
        entry.itemLabels.push(formatItemLabel({ sku: item.sku, name: item.item_name, category: item.category }));
        pendingReleases.set(pendingRelease.shipmentId, entry);
      }
      documentItems.push({
        id: item.id,
        reservationId: reservation.id,
        reservationUpdatedAt: reservation.updated_at,
        stockItemId: item.stock_item_id,
        sku: item.sku,
        itemName: item.item_name,
        category: item.category,
        orderedAt,
        quantity: ledgerItem.remainingQty,
        unitPrice: Number(item.unit_price),
        discount: Number(item.discount ?? 0),
        lineTotal: ledgerItem.remainingSubtotal,
        canShip:
          !pendingRelease &&
          !reservation.archived_at &&
          ["reserved", "paid", "delivered"].includes(reservation.status),
        canRecordPayment:
          reservation.status === "reserved" &&
          !reservation.archived_at &&
          Boolean(reservation.pricing_complete) &&
          Number(reservation.balance) > 0,
        pendingRelease,
      });
      if (reservation.status === "reserved" && !reservation.archived_at) {
        editableItems.push({
          reservationItemId: item.id,
          stockItemId: item.stock_item_id,
          sku: item.sku,
          itemName: item.item_name,
          category: item.category,
          orderedAt,
          quantity: ledgerItem.remainingQty,
          unitPrice: Number(item.unit_price),
          discount: Number(item.discount ?? 0),
        });
      }
    }
    if (editableItems.length > 0) {
      editorReservations.push({ reservation, items: editableItems });
      editableReservations.push({
        id: reservation.id,
        needsPricing: !reservation.pricing_complete,
      });
    }
  }

  // A customer with everything released still opens, to reach the release PDFs.
  if (
    !documentItems.length &&
    !reservations.some((reservation) => shippedOf(reservation.id).length > 0)
  ) {
    return null;
  }

  const cycle = computeCycleTotals(cycleOrders);

  const customer =
    (customers ?? []).find(
      (candidate) => normalizeCustomerName(candidate.name) === normalizedTarget,
    ) ?? customers?.[0];
  const candidateDetails = matchingCandidates[0];
  const sortedReservations = [...reservations].sort(
    (a, b) => new Date(b.reserved_at).getTime() - new Date(a.reserved_at).getTime(),
  );
  const statuses = new Set(reservations.map((reservation) => reservation.status));
  const delivered = reservations.every((reservation) => Boolean(reservation.delivered_at));
  const editorReservation = editorReservations[0];

  return {
    customerName: customer?.name ?? candidateDetails?.customer_name ?? customerName,
    facebookName: customer?.facebook_name ?? candidateDetails?.customer_facebook_name ?? null,
    phone: customer?.phone ?? candidateDetails?.customer_phone ?? null,
    address: customer?.address ?? null,
    notes: [...new Set(reservations.map((reservation) => reservation.notes?.trim()).filter(Boolean))].join("\n\n") || null,
    invoiceDate: sortedReservations[0]?.reserved_at ?? null,
    statusLabel: statuses.size === 1
      ? getInvoiceStatusLabel(sortedReservations[0]?.status ?? "reserved")
      : "Multiple orders",
    delivered,
    items: documentItems.sort(
      (a, b) => new Date(a.orderedAt ?? 0).getTime() - new Date(b.orderedAt ?? 0).getTime(),
    ),
    totals: {
      subtotal,
      discount,
      total,
      quantity,
      amountPaid: cycle.remainingDownpayment,
      downpayment,
      balance: cycle.remainingBalance,
    },
    releases: reservations
      .flatMap((reservation) => shippedOf(reservation.id))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map((shipment) => ({ id: shipment.id, shipmentNo: shipment.shipment_no })),
    availableDownpayment: cycle.availableDownpayment,
    unappliedDownpayment: cycle.unappliedDownpayment,
    editor: editorReservation
      ? {
          reservationId: editorReservation.reservation.id,
          customerId: editorReservation.reservation.customer_id,
          updatedAt: editorReservation.reservation.updated_at,
          items: editorReservation.items,
        }
      : null,
    editableReservations,
    reservations: reservations.map((reservation) => ({
      id: reservation.id,
      status: reservation.status,
      updatedAt: reservation.updated_at,
      archived: Boolean(reservation.archived_at),
      balance: Number(reservation.balance),
      pricingComplete: Boolean(reservation.pricing_complete),
      remainingGross: invoiceAmountsByReservation.get(reservation.id)?.remainingGross ?? 0,
      remainingDiscount: invoiceAmountsByReservation.get(reservation.id)?.remainingDiscount ?? 0,
    })),
    pendingReleases: [...pendingReleases.values()],
  };
}
