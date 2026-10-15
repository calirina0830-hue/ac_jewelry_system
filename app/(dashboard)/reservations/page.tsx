import type { Metadata } from "next";
import Link from "next/link";

import {
  archiveReservation,
  bulkTransitionReservations,
  deleteAllArchivedReservations,
  deleteArchivedReservation,
  restoreReservation,
  transitionReservationStatus,
} from "@/actions/reservations";
import {
  BulkReviewButton,
  BulkRowCheckbox,
  BulkSelectAll,
  BulkSelectionCount,
  BulkSelectionMessage,
  BulkSelectionProvider,
  BulkSubmitButton,
} from "@/components/reservations/bulk-reservation-controls";
import {
  ReservationActionsMenu,
  ReservationActionsSeparator,
} from "@/components/reservations/reservation-actions-menu";
import { ReservationStatus } from "@/components/reservations/reservation-status";
import { ReservationFilters } from "@/components/reservations/reservation-filters";
import {
  ReservationItemCell,
  type ReservationItemSummary,
} from "@/components/reservations/reservation-item-cell";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { PageNotice } from "@/components/ui/page-notice";
import { Pagination } from "@/components/ui/pagination";
import { SortLink } from "@/components/ui/sort-link";
import { getCurrentProfile, roleCanWrite, roleIsAdmin } from "@/lib/auth";
import { PAGE_SIZE } from "@/lib/constants/pagination";
import { formatCurrency, formatDate } from "@/lib/format";
import { sanitizeSearchTerm, toSearchParams } from "@/lib/query";
import {
  canRecordReservationPayment,
  getPaymentIneligibilityReason,
  needsReservationPricing,
} from "@/lib/reservations/payment-eligibility";
import { getReservationTransitions } from "@/lib/reservations/status";
import { createClient } from "@/lib/supabase/server";
import { reservationQuerySchema } from "@/lib/validation/reservations";

export const metadata: Metadata = { title: "Reservations" };

const BULK_RESERVATION_FORM_ID = "bulk-reservation-form";

const STATUS_TABS = [
  { value: "reserved", label: "Reserved" },
  { value: "paid", label: "Paid" },
  { value: "delivered", label: "Delivered" },
  { value: "cancelled", label: "Cancelled" },
] as const;

function getEmptyStateConfig(status: string, archive: string, canWrite: boolean, search: string) {
  if (search) {
    return {
      title: "No matching reservations",
      description: "Try adjusting the search or filters.",
      actionHref: undefined,
      actionLabel: undefined,
    };
  }

  if (archive === "archived" || (status === "all" && archive === "archived")) {
    return {
      title: "No archived orders",
      description: "There are no archived orders matching the current filters.",
      actionHref: undefined,
      actionLabel: undefined,
    };
  }

  switch (status) {
    case "reserved":
      return {
        title: "No reserved orders",
        description: "There are no reserved orders matching the current filters.",
        actionHref: canWrite ? "/reservations/new" : undefined,
        actionLabel: canWrite ? "Create first reservation" : undefined,
      };
    case "paid":
      return {
        title: "No paid orders",
        description: "There are no paid orders matching the current filters.",
        actionHref: undefined,
        actionLabel: undefined,
      };
    case "delivered":
      return {
        title: "No delivered orders",
        description: "There are no delivered orders matching the current filters.",
        actionHref: undefined,
        actionLabel: undefined,
      };
    case "cancelled":
      return {
        title: "No cancelled orders",
        description: "There are no cancelled orders matching the current filters.",
        actionHref: undefined,
        actionLabel: undefined,
      };
    case "all":
      return {
        title: "No active orders",
        description: "There are no active orders matching the current filters.",
        actionHref: canWrite ? "/reservations/new" : undefined,
        actionLabel: canWrite ? "Create first reservation" : undefined,
      };
    default:
      return {
        title: "No reservations yet",
        description: "Create the first reservation to begin tracking customer jewelry orders.",
        actionHref: canWrite ? "/reservations/new" : undefined,
        actionLabel: canWrite ? "Create first reservation" : undefined,
      };
  }
}

type ReservationsPageProps = {
  searchParams: Promise<{
    q?: string;
    liveBatch?: string;
    fromDate?: string;
    toDate?: string;
    status?: string;
    archive?: string;
    sort?: string;
    direction?: string;
    page?: string;
    pageSize?: string;
    message?: string;
    error?: string;
  }>;
};

export default async function ReservationsPage({
  searchParams,
}: ReservationsPageProps) {
  const rawParams = await searchParams;
  const filters = reservationQuerySchema.parse(rawParams);
  const search = sanitizeSearchTerm(filters.q);
  const profile = await getCurrentProfile();
  const canWrite = roleCanWrite(profile?.role);
  const isAdmin = roleIsAdmin(profile?.role);
  const supabase = await createClient();

  const isAll = filters.pageSize === "all";
  const limit = isAll ? null : Number(filters.pageSize);
  const from = isAll ? 0 : (filters.page - 1) * (limit ?? PAGE_SIZE);
  const to = isAll ? undefined : from + (limit ?? PAGE_SIZE) - 1;

  let query = supabase.from("reservation_list").select("*", { count: "exact" });

  if (filters.status === "delivered") {
    // Include reservations with delivered_at or that have shipped shipments
    const { data: shippedShipments } = await supabase
      .from("reservation_shipments")
      .select("reservation_id")
      .eq("status", "shipped");
    const shippedResIds = [
      ...new Set((shippedShipments ?? []).map((s) => s.reservation_id)),
    ];
    let condition = "delivered_at.not.is.null";
    if (shippedResIds.length > 0) {
      condition += ",id.in.(" + shippedResIds.join(",") + ")";
    }
    query = query.or(condition);
  } else if (filters.status === "reserved") {
    query = query.eq("status", "reserved");
  } else if (filters.status !== "all") {
    query = query.eq("status", filters.status);
  }

  if (filters.archive === "active") {
    query = query.is("archived_at", null);
  } else if (filters.archive === "archived") {
    query = query.not("archived_at", "is", null);
  }

  if (filters.liveBatch) {
    query = query.eq("live_batch", filters.liveBatch);
  }

  const operationalDateColumn =
    filters.status === "paid"
      ? "paid_at"
      : filters.status === "delivered"
        ? "delivered_at"
        : filters.status === "cancelled"
          ? "cancelled_at"
          : "reserved_at";
  const sortColumn = rawParams.sort ? filters.sort : operationalDateColumn;
  if (filters.fromDate) {
    query = query.gte(
      operationalDateColumn,
      new Date(filters.fromDate + "T00:00:00+08:00").toISOString(),
    );
  }
  if (filters.toDate) {
    query = query.lt(
      operationalDateColumn,
      new Date(
        new Date(filters.toDate + "T00:00:00+08:00").getTime() + 86_400_000,
      ).toISOString(),
    );
  }

  let itemMatchIds: string[] = [];
  if (search) {
    const { data: itemMatches } = await supabase
      .from("reservation_items")
      .select("reservation_id")
      .or(
        "sku.ilike.%" +
          search +
          "%,item_name.ilike.%" +
          search +
          "%",
      );
    itemMatchIds = [
      ...new Set((itemMatches ?? []).map((item) => item.reservation_id)),
    ];
  }

  if (search) {
    const pattern = "%" + search + "%";
    let condition =
      "reservation_no.ilike." +
      pattern +
      ",customer_name.ilike." +
      pattern +
      ",customer_facebook_name.ilike." +
      pattern;
    if (itemMatchIds.length) {
      condition += ",id.in.(" + itemMatchIds.join(",") + ")";
    }
    query = query.or(condition);
  }

  const orderedQuery = query.order(sortColumn, { ascending: filters.direction === "asc" });
  const { data: reservations, count, error } = isAll
    ? await orderedQuery.limit(2000)
    : await orderedQuery.range(from, to ?? from + PAGE_SIZE - 1);

  const reservationIds = (reservations ?? []).map(
    (reservation) => reservation.id,
  );
  const resMap = new Map((reservations ?? []).map((r) => [r.id, r]));
  const itemsByReservation = new Map<string, ReservationItemSummary[]>();
  const releasedValueByReservation = new Map<string, number>();
  const remainingValueByReservation = new Map<string, number>();
  const downpaymentAppliedByReservation = new Map<string, number>();
  if (reservationIds.length) {
    const { data: reservationItems } = await supabase
      .from("reservation_items")
      .select("id, reservation_id, sku, item_name, category, quantity, unit_price, discount")
      .in("reservation_id", reservationIds)
      .order("created_at");

    // Fetch confirmed shipments for these reservations
    const { data: shipments } = await supabase
      .from("reservation_shipments")
      .select("id, reservation_id, status, downpayment_applied")
      .in("reservation_id", reservationIds)
      .eq("status", "shipped");

    const shippedResIds = new Set((shipments ?? []).map((s) => s.reservation_id));
    const shipmentIds = (shipments ?? []).map((s) => s.id);

    for (const s of shipments ?? []) {
      downpaymentAppliedByReservation.set(
        s.reservation_id,
        (downpaymentAppliedByReservation.get(s.reservation_id) ?? 0) + Number(s.downpayment_applied ?? 0),
      );
    }

    const shippedByItem = new Map<string, number>();
    if (shipmentIds.length > 0) {
      const { data: shipmentItems } = await supabase
        .from("reservation_shipment_items")
        .select("reservation_item_id, quantity")
        .in("shipment_id", shipmentIds);

      for (const si of shipmentItems ?? []) {
        shippedByItem.set(
          si.reservation_item_id,
          (shippedByItem.get(si.reservation_item_id) ?? 0) + Number(si.quantity),
        );
      }
    }

    for (const item of reservationItems ?? []) {
      const totalQty = Number(item.quantity);
      const shippedQty = Math.min(shippedByItem.get(item.id) ?? 0, totalQty);
      const remainingQty = Math.max(totalQty - shippedQty, 0);

      const unitPrice = Number(item.unit_price ?? 0);
      const discount = Number(item.discount ?? 0);
      const fractionOfLine = totalQty > 0 ? 1 / totalQty : 0;

      const releasedItemValue =
        shippedQty > 0
          ? Math.max(unitPrice * shippedQty - discount * (shippedQty * fractionOfLine), 0)
          : 0;
      const remainingItemValue =
        remainingQty > 0
          ? Math.max(unitPrice * remainingQty - discount * (remainingQty * fractionOfLine), 0)
          : 0;

      releasedValueByReservation.set(
        item.reservation_id,
        (releasedValueByReservation.get(item.reservation_id) ?? 0) + releasedItemValue,
      );
      remainingValueByReservation.set(
        item.reservation_id,
        (remainingValueByReservation.get(item.reservation_id) ?? 0) + remainingItemValue,
      );

      // On 'reserved' status tab, don't show items that have already been released
      if (filters.status === "reserved" && shippedQty > 0 && remainingQty <= 0) {
        continue;
      }
      // On 'delivered' status tab:
      // If shipments were recorded for this reservation, only include items that were shipped (shippedQty > 0).
      // If no shipment records exist, only include items if the reservation itself is marked 'delivered'.
      if (filters.status === "delivered") {
        if (shippedResIds.has(item.reservation_id)) {
          if (shippedQty <= 0) continue;
        } else if (resMap.get(item.reservation_id)?.status !== "delivered") {
          continue;
        }
      }

      const summary = {
        sku: item.sku ?? "",
        itemName: item.item_name ?? "",
        category: item.category ?? "",
      };
      const existing = itemsByReservation.get(item.reservation_id);
      if (existing) {
        existing.push(summary);
      } else {
        itemsByReservation.set(item.reservation_id, [summary]);
      }
    }
  }

  const totalCount = count ?? 0;
  const pageCount = isAll || !limit ? 1 : Math.max(1, Math.ceil(totalCount / limit));
  const bulkEnabled =
    filters.archive === "active" &&
    canWrite &&
    (filters.status === "reserved" || filters.status === "paid");
  const queryValues = {
    q: search || undefined,
    liveBatch: filters.liveBatch || undefined,
    fromDate: filters.fromDate || undefined,
    toDate: filters.toDate || undefined,
    status: filters.status,
    archive: filters.archive,
    pageSize: filters.pageSize !== "10" ? filters.pageSize : undefined,
    sort: sortColumn,
    direction: filters.direction,
  };
  const bulkSelectionRows = bulkEnabled
    ? (reservations ?? []).map((reservation) => ({
        id: reservation.id,
        label: reservation.reservation_no,
        paymentIneligibilityReason:
          getPaymentIneligibilityReason(reservation),
      }))
    : [];

  type ReservationRow = NonNullable<typeof reservations>[number];
  type CustomerGroup = {
    key: string;
    customerName: string;
    facebookName: string | null;
    phone: string | null;
    items: ReservationRow[];
    totalAmount: number;
    totalPaid: number;
    totalDownpayment: number;
    totalBalance: number;
  };

  const customerGroups: CustomerGroup[] = [];
  const groupIndexByKey = new Map<string, number>();

  for (const reservation of reservations ?? []) {
    let resTotal = Number(reservation.total);
    let resPaid = Number(reservation.downpayment);
    let resDownpayment = 0;
    let resBalance = Number(reservation.balance);

    if (filters.status === "delivered") {
      // In delivered view: if this reservation had partial releases, show the released goods value,
      // the downpayment applied to those released shipments, and the remaining balance on them.
      const hasShipments = downpaymentAppliedByReservation.has(reservation.id) || (releasedValueByReservation.get(reservation.id) ?? 0) > 0;
      resDownpayment = downpaymentAppliedByReservation.get(reservation.id) ?? 0;
      if (hasShipments) {
        resTotal = releasedValueByReservation.get(reservation.id) ?? 0;
        resPaid = resDownpayment;
        resBalance = Math.max(resTotal - resPaid, 0);
      } else if (reservation.status !== "delivered") {
        // If it was fetched because of delivered_at on another row or sibling, but this reservation
        // itself has no released items and is not delivered, don't include it in delivered view.
        continue;
      }
    } else if (filters.status === "reserved") {
      // In reserved view: if items were partially released, show the remaining items value,
      // unapplied downpayment, and balance due on remaining items.
      const hasShipments = downpaymentAppliedByReservation.has(reservation.id) || (releasedValueByReservation.get(reservation.id) ?? 0) > 0;
      if (hasShipments && reservation.status === "reserved") {
        resTotal = remainingValueByReservation.get(reservation.id) ?? resTotal;
        const appliedDp = downpaymentAppliedByReservation.get(reservation.id) ?? 0;
        resPaid = Math.max(resPaid - appliedDp, 0);
        resBalance = Math.max(resTotal - resPaid, 0);
      }
    }

    // Reserved and Paid views compile every order belonging to the same
    // customer. Delivered, Cancelled, All, and Archive keep transaction rows
    // separate so their existing release/history behavior does not change.
    const compileByCustomer =
      filters.status === "reserved" || filters.status === "paid";
    const normalizedKey =
      compileByCustomer
        ? "customer:" + reservation.customer_id
        : reservation.id;

    const existingIndex = groupIndexByKey.get(normalizedKey);
    if (existingIndex !== undefined) {
      const group = customerGroups[existingIndex];
      group.items.push(reservation);
      group.totalAmount += resTotal;
      group.totalPaid += resPaid;
      group.totalDownpayment += resDownpayment;
      group.totalBalance += resBalance;
      if (!group.facebookName && reservation.customer_facebook_name) {
        group.facebookName = reservation.customer_facebook_name;
      }
      if (!group.phone && reservation.customer_phone) {
        group.phone = reservation.customer_phone;
      }
    } else {
      groupIndexByKey.set(normalizedKey, customerGroups.length);
      customerGroups.push({
        key: normalizedKey,
        customerName: reservation.customer_name ?? "Unnamed Customer",
        facebookName: reservation.customer_facebook_name ?? null,
        phone: reservation.customer_phone ?? null,
        items: [reservation],
        totalAmount: resTotal,
        totalPaid: resPaid,
        totalDownpayment: resDownpayment,
        totalBalance: resBalance,
      });
    }
  }

  const showingCount = reservations?.length ?? 0;

  return (
    <div className="mx-auto max-w-[1550px] px-5 py-8 sm:px-8 lg:px-10 lg:py-10">
      <PageHeader
        actionHref={canWrite ? "/reservations/new" : undefined}
        actionLabel={canWrite ? "Create reservation" : undefined}
        description="Manage active jewelry reservations, customer commitments, and balances."
        eyebrow="Order management"
        title="Reservations"
      >
        {canWrite && (
          <>
            <Link
              className="inline-flex h-11 items-center rounded-xl border border-border bg-white px-5 text-sm font-semibold text-ink hover:border-gold"
              href="/reservations/import"
            >
              Import Live Orders
            </Link>
            <Link
              className="inline-flex h-11 items-center rounded-xl border border-border bg-white px-5 text-sm font-semibold text-ink hover:border-gold"
              href={
                "/reservations/export?" +
                toSearchParams(queryValues).toString()
              }
            >
              Export CSV
            </Link>
          </>
        )}
      </PageHeader>
      <PageNotice error={rawParams.error} message={rawParams.message} />

      <nav
        aria-label="Reservation status views"
        className="mt-6 flex flex-wrap gap-2"
      >
        {STATUS_TABS.map((tab) => {
          const params = toSearchParams({
            q: search || undefined,
            liveBatch: filters.liveBatch || undefined,
            fromDate: filters.fromDate || undefined,
            toDate: filters.toDate || undefined,
            status: tab.value,
            archive: "active",
            pageSize: filters.pageSize !== "10" ? filters.pageSize : undefined,
            sort: tab.value === filters.status ? sortColumn : undefined,
            direction: filters.direction,
          });
          const active = filters.archive === "active" && filters.status === tab.value;

          return (
            <Link
              aria-current={active ? "page" : undefined}
              className={
                "rounded-xl border px-4 py-2.5 text-sm font-bold transition " +
                (active
                  ? "border-ink bg-ink text-white"
                  : "border-border bg-white text-muted hover:border-gold hover:text-ink")
              }
              href={"/reservations?" + params.toString()}
              key={tab.value}
            >
              {tab.label}
            </Link>
          );
        })}
        <span className="mx-1 hidden w-px bg-border sm:block" />
        <Link
          aria-current={filters.status === "all" && filters.archive === "active" ? "page" : undefined}
          className={
            "rounded-xl border px-4 py-2.5 text-sm font-bold transition " +
            (filters.status === "all" && filters.archive === "active"
              ? "border-ink bg-ink text-white"
              : "border-border bg-white text-muted hover:border-gold hover:text-ink")
          }
          href={
            filters.pageSize !== "10"
              ? `/reservations?status=all&archive=active&pageSize=${filters.pageSize}`
              : "/reservations?status=all&archive=active"
          }
        >
          All active
        </Link>
        <Link
          aria-current={filters.archive === "archived" ? "page" : undefined}
          className={
            "rounded-xl border px-4 py-2.5 text-sm font-bold transition " +
            (filters.archive === "archived"
              ? "border-stone-700 bg-stone-700 text-white"
              : "border-border bg-white text-muted hover:border-gold hover:text-ink")
          }
          href={
            filters.pageSize !== "10"
              ? `/reservations?status=all&archive=archived&pageSize=${filters.pageSize}`
              : "/reservations?status=all&archive=archived"
          }
        >
          Archive
        </Link>
      </nav>

      {/* Supported query inputs: name="fromDate" name="toDate" */}
      <ReservationFilters
        initialFilters={{
          q: search,
          liveBatch: filters.liveBatch,
          fromDate: filters.fromDate,
          toDate: filters.toDate,
          status: filters.status,
          archive: filters.archive,
          pageSize: filters.pageSize,
          sort: rawParams.sort ? filters.sort : undefined,
          direction: filters.direction,
        }}
      />

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 px-1 text-xs text-muted">
        <div>
          Showing <strong className="text-ink">{showingCount}</strong> of{" "}
          <strong className="text-ink">{totalCount}</strong> matching reservation{totalCount === 1 ? "" : "s"}
          {customerGroups.length > 0 && customerGroups.length !== showingCount && (
            <span> (grouped under <strong className="text-ink">{customerGroups.length}</strong> customer{customerGroups.length === 1 ? "" : "s"})</span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {filters.pageSize !== "10" && (
            <div className="font-semibold text-gold-dark">
              Page size: {filters.pageSize === "all" ? "See All" : filters.pageSize + " records"}
            </div>
          )}
          {isAdmin && filters.archive === "archived" && (reservations?.length ?? 0) > 0 && (
            <ConfirmAction
              action={deleteAllArchivedReservations}
              appearance="compact-danger"
              confirmation="Are you sure you want to permanently delete ALL archived reservations? This cannot be undone."
              variant="danger"
            >
              Delete All Archived
            </ConfirmAction>
          )}
        </div>
      </div>

      <BulkSelectionProvider rows={bulkSelectionRows}>
      <section className="mt-3 overflow-hidden rounded-2xl border border-border bg-white shadow-card">
        {error ? (
          <div className="px-6 py-14 text-center text-sm text-red-700" role="alert">
            Reservations could not be loaded. Confirm the Phase 3 migration has
            been applied.
          </div>
        ) : !reservations?.length ? (
          (() => {
            const emptyConfig = getEmptyStateConfig(filters.status, filters.archive, canWrite, search);
            return (
              <EmptyState
                actionHref={emptyConfig.actionHref}
                actionLabel={emptyConfig.actionLabel}
                description={emptyConfig.description}
                title={emptyConfig.title}
              />
            );
          })()
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1250px] border-collapse text-left">
                <thead className="bg-canvas text-[11px] uppercase tracking-[0.14em] text-muted">
                  <tr>
                    {bulkEnabled && (
                      <th className="w-12 px-5 py-4 font-bold">
                        <BulkSelectAll />
                      </th>
                    )}
                    <th className="px-5 py-4 font-bold">
                      <SortLink activeColumn={sortColumn} column="reservation_no" direction={filters.direction} pathname="/reservations" query={queryValues}>
                        Reservation no.
                      </SortLink>
                    </th>
                    <th className="px-5 py-4 font-bold">
                      <SortLink activeColumn={sortColumn} column="customer_name" direction={filters.direction} pathname="/reservations" query={queryValues}>
                        Customer
                      </SortLink>
                    </th>
                    <th className="px-5 py-4 font-bold">Item</th>
                    <th className="px-5 py-4 font-bold">Total</th>
                    <th className="px-5 py-4 font-bold">Total Paid</th>
                    {filters.status === "delivered" && (
                      <th className="px-5 py-4 font-bold">Downpayment</th>
                    )}
                    <th className="px-5 py-4 font-bold">Balance</th>
                    <th className="px-5 py-4 font-bold">Status</th>
                    <th className="px-5 py-4 font-bold">
                      <SortLink activeColumn={sortColumn} column={operationalDateColumn} direction={filters.direction} pathname="/reservations" query={queryValues}>
                        {operationalDateColumn === "paid_at"
                          ? "Paid date"
                          : operationalDateColumn === "delivered_at"
                            ? "Delivered date"
                            : operationalDateColumn === "cancelled_at"
                              ? "Cancelled date"
                              : "Reserved date"}
                      </SortLink>
                    </th>
                    <th className="w-28 px-5 py-4 text-right font-bold">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {customerGroups.map((group) => {
                    const isMulti = group.items.length > 1;
                    const primaryReservation = group.items[0];
                    // Compile items from all reservations for this customer
                    const combinedItems = group.items.flatMap(
                      (reservation) => itemsByReservation.get(reservation.id) ?? [],
                    );
                    // Determine if any reservation in the group is partially paid
                    const hasPartiallyPaid = group.items.some(
                      (r) =>
                        r.status === "reserved" &&
                        Number(r.downpayment) > 0 &&
                        Number(r.balance) > 0,
                    );
                    // Determine consolidated status
                    const allSameStatus = group.items.every(
                      (r) => r.status === primaryReservation.status,
                    );
                    const allArchived = group.items.every((r) => Boolean(r.archived_at));
                    const allDelivered = group.items.every((r) => Boolean(r.delivered_at));

                    // Earliest/primary operational date
                    const operationalDate =
                      operationalDateColumn === "paid_at"
                        ? primaryReservation.paid_at ?? primaryReservation.reserved_at
                        : operationalDateColumn === "delivered_at"
                          ? primaryReservation.delivered_at ?? primaryReservation.reserved_at
                          : operationalDateColumn === "cancelled_at"
                            ? primaryReservation.cancelled_at ?? primaryReservation.reserved_at
                            : primaryReservation.reserved_at;

                    return (
                      <tr className="transition hover:bg-canvas/70" key={group.key}>
                        {bulkEnabled && (
                          <td className="px-5 py-4">
                            <BulkRowCheckbox
                              label={
                                "Select " +
                                (isMulti
                                  ? group.items.length + " orders for " + group.customerName
                                  : primaryReservation.reservation_no)
                              }
                              value={group.items.map((reservation) => reservation.id)}
                            />
                          </td>
                        )}
                        <td className="whitespace-nowrap px-5 py-4">
                          <Link
                            className="font-bold text-gold-dark hover:underline"
                            href={"/reservations/" + primaryReservation.id}
                          >
                            {primaryReservation.reservation_no}
                          </Link>
                          {isMulti && (
                            <div className="mt-0.5">
                              <span className="inline-block rounded bg-gold/15 px-1.5 py-0.5 text-[10px] font-semibold text-gold-dark">
                                +{group.items.length - 1} combined order{group.items.length - 1 === 1 ? "" : "s"}
                              </span>
                              <div className="mt-1 flex max-w-48 flex-wrap gap-x-2 gap-y-1 text-[10px] font-semibold">
                                {group.items.slice(1).map((reservation) => (
                                  <Link
                                    className="text-gold-dark hover:underline"
                                    href={"/reservations/" + reservation.id}
                                    key={reservation.id}
                                  >
                                    {reservation.reservation_no}
                                  </Link>
                                ))}
                              </div>
                            </div>
                          )}
                        </td>
                        <td className="px-5 py-4">
                          <p className="font-semibold text-ink">{group.customerName}</p>
                          <p className="mt-1 text-xs font-medium text-muted">
                            {group.facebookName
                              ? "Facebook / CS: " + group.facebookName
                              : group.phone ?? "No Facebook / CS name"}
                          </p>
                          {hasPartiallyPaid && (
                            <span className="mt-1 inline-flex rounded-full bg-sky-50 px-2 py-0.5 text-[10px] font-bold text-sky-700">
                              Partially Paid
                            </span>
                          )}
                        </td>
                        <td className="px-5 py-4">
                          <ReservationItemCell items={combinedItems} />
                        </td>
                        <td className="whitespace-nowrap px-5 py-4 text-sm font-semibold text-ink">
                          {formatCurrency(group.totalAmount)}
                        </td>
                        <td className="whitespace-nowrap px-5 py-4 text-sm text-muted">
                          {formatCurrency(group.totalPaid)}
                        </td>
                        {filters.status === "delivered" && (
                          <td className="whitespace-nowrap px-5 py-4 text-sm text-muted">
                            {formatCurrency(group.totalDownpayment)}
                          </td>
                        )}
                        <td className="whitespace-nowrap px-5 py-4 text-sm font-bold text-ink">
                          {formatCurrency(group.totalBalance)}
                        </td>
                        <td className="px-5 py-4">
                          {filters.status === "delivered" ? (
                            <ReservationStatus
                              archived={allArchived}
                              status="delivered"
                            />
                          ) : allSameStatus ? (
                            <ReservationStatus
                              archived={allArchived}
                              delivered={allDelivered}
                              status={primaryReservation.status}
                            />
                          ) : (
                            <span className="rounded-full bg-stone-100 px-2.5 py-1 text-xs font-bold text-stone-700">
                              Multiple ({group.items.map((r) => r.status).join(", ")})
                            </span>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-5 py-4 text-sm text-muted">
                          {formatDate(operationalDate)}
                        </td>
                        <td className="px-5 py-4">
                          <div className="flex justify-end">
                            <ReservationActionsMenu>
                              {(() => {
                                const reservation = primaryReservation;
                                return (
                                  <>
                                    <Link
                                      className="text-gold-dark"
                                      href={
                                        "/reservations/" +
                                        reservation.id +
                                        (filters.status === "delivered" ? "?view=delivered" : "")
                                      }
                                    >
                                      {filters.status === "delivered" ? "View order" : "View Reservation"}
                                    </Link>
                                    {filters.status !== "delivered" && (
                                      <Link className="text-gold-dark" href={"/reservations/" + reservation.id + "/invoice"}>
                                        View Invoice
                                      </Link>
                                    )}
                                    {filters.status !== "delivered" && (
                                      <>
                                        {!reservation.archived_at &&
                                          ((canWrite && reservation.status === "reserved") ||
                                            (isAdmin && reservation.status === "paid")) && (
                                          <ReservationActionsSeparator />
                                        )}
                                        {canWrite && !reservation.archived_at && reservation.status === "reserved" && (
                                          canRecordReservationPayment(reservation) ? (
                                            <Link className="text-emerald-700" href={"/reservations/bulk/pay?ids=" + reservation.id}>
                                              Record Payment
                                            </Link>
                                          ) : needsReservationPricing(reservation) ? (
                                            <Link className="text-amber-700" href={"/reservations/" + reservation.id + "/edit"}>
                                              Complete Pricing
                                            </Link>
                                          ) : null
                                        )}
                                        {isAdmin && !reservation.archived_at && reservation.status === "paid" && (
                                          <Link className="text-red-700" href={"/reservations/bulk/revert?ids=" + reservation.id}>
                                            Revert to Reserved
                                          </Link>
                                        )}
                                        {canWrite && !reservation.archived_at && reservation.status === "reserved" && (
                                          <Link className="text-ink" href={"/reservations/" + reservation.id + "/edit"}>
                                            Edit Reservation
                                          </Link>
                                        )}
                                        {((!reservation.archived_at &&
                                          getReservationTransitions(
                                            profile?.role,
                                            reservation.status,
                                          ).length > 0) ||
                                          isAdmin) && (
                                          <ReservationActionsSeparator />
                                        )}
                                        {!reservation.archived_at &&
                                          getReservationTransitions(
                                            profile?.role,
                                            reservation.status,
                                          ).map((transition) => (
                                            <ConfirmAction
                                              action={transitionReservationStatus.bind(
                                                null,
                                                reservation.id,
                                                transition.to,
                                                reservation.updated_at,
                                              )}
                                              confirmation={transition.confirmation}
                                              key={transition.to}
                                              variant={transition.destructive ? "danger" : "neutral"}
                                            >
                                              {transition.label}
                                            </ConfirmAction>
                                          ))}
                                      </>
                                    )}
                                    {isAdmin && (reservation.archived_at ? (
                                      <>
                                        <ConfirmAction
                                          action={restoreReservation.bind(null, reservation.id)}
                                          confirmation={"Restore " + reservation.reservation_no + " to the active list?"}
                                          variant="neutral"
                                        >
                                          Restore
                                        </ConfirmAction>
                                        <ConfirmAction
                                          action={deleteArchivedReservation.bind(null, reservation.id)}
                                          confirmation={"Permanently delete " + reservation.reservation_no + "? This cannot be undone."}
                                          variant="danger"
                                        >
                                          Delete Permanently
                                        </ConfirmAction>
                                      </>
                                    ) : (
                                      <ConfirmAction
                                        action={archiveReservation.bind(null, reservation.id)}
                                        confirmation={"Archive " + reservation.reservation_no + "? Its business status and stock commitment will remain unchanged."}
                                      >
                                        Archive
                                      </ConfirmAction>
                                    ))}
                                  </>
                                );
                              })()}
                            </ReservationActionsMenu>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {bulkEnabled && (
              <form
                action={bulkTransitionReservations}
                className="border-t border-border bg-canvas px-4 py-4 sm:px-5"
                id={BULK_RESERVATION_FORM_ID}
              >
                <div className="flex flex-col gap-3 md:flex-row md:items-center">
                  <p className="text-xs font-semibold text-muted md:mr-auto">
                    Bulk selection applies only to this visible page.
                  </p>
                  <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
                    <BulkSelectionCount />
                    {filters.status === "reserved" && (
                      <>
                        <BulkReviewButton destination="pay">
                          Record payments
                        </BulkReviewButton>
                        {isAdmin && (
                          <BulkSubmitButton
                            confirmation="Cancel {count} selected Reserved reservation(s)? Their virtual stock commitments will be released."
                            operation="cancel"
                            tone="danger"
                          >
                            Cancel Selected
                          </BulkSubmitButton>
                        )}
                      </>
                    )}
                    {filters.status === "paid" && (
                      <>
                        <BulkSubmitButton
                          confirmation="Mark {count} selected Paid reservation(s) as Delivered?"
                          operation="deliver"
                        >
                          Mark Selected as Delivered
                        </BulkSubmitButton>
                        {isAdmin && (
                          <BulkReviewButton destination="revert" tone="danger">
                            Revert Selected to Reserved
                          </BulkReviewButton>
                        )}
                      </>
                    )}
                    <BulkSelectionMessage />
                  </div>
                </div>
              </form>
            )}
            <Pagination page={filters.page} pageCount={pageCount} pathname="/reservations" query={queryValues} />
          </>
        )}
      </section>
      </BulkSelectionProvider>
    </div>
  );
}
