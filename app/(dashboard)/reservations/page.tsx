import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

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
import { toSearchParams } from "@/lib/query";
import {
  PRIVATE_SEARCH_COOKIE_NAMES,
  readPrivateSearchTerm,
} from "@/lib/private-search";
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
  { value: "partially-paid", label: "Partially Paid" },
  { value: "paid", label: "Paid" },
  { value: "delivered", label: "Delivered" },
  { value: "settled", label: "Settled Orders" },
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
    case "partially-paid":
      return {
        title: "No partially paid orders",
        description:
          "There are no orders with an active payment and a remaining balance.",
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
    case "settled":
      return {
        title: "No settled orders",
        description: "There are no delivered orders with a zero balance yet.",
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
  // Start authentication immediately, but do not put it on the critical path
  // for an ordinary list request. The profile is only required up front when
  // a private search cookie must be checked against its owner.
  const profilePromise = getCurrentProfile();
  const [supabase, cookieStore] = await Promise.all([
    createClient(),
    cookies(),
  ]);
  const privateSearchCookie = cookieStore.get(
    PRIVATE_SEARCH_COOKIE_NAMES.reservations,
  )?.value;
  const profileForPrivateSearch = privateSearchCookie
    ? await profilePromise
    : null;
  const search = readPrivateSearchTerm(
    privateSearchCookie,
    profileForPrivateSearch?.id,
  );
  const filters = reservationQuerySchema.parse({ ...rawParams, q: search });
  if (rawParams.q !== undefined) {
    redirect(
      "/reservations?" +
        toSearchParams({
          liveBatch: filters.liveBatch,
          fromDate: filters.fromDate,
          toDate: filters.toDate,
          status: filters.status,
          archive: filters.archive,
          sort: rawParams.sort ? filters.sort : undefined,
          direction: rawParams.sort ? filters.direction : undefined,
          page: filters.page,
          pageSize: filters.pageSize !== "10" ? filters.pageSize : undefined,
        }).toString(),
    );
  }
  const isAll = filters.pageSize === "all";
  const limit = isAll ? null : Number(filters.pageSize);
  const from = isAll ? 0 : (filters.page - 1) * (limit ?? PAGE_SIZE);
  const to = isAll ? undefined : from + (limit ?? PAGE_SIZE) - 1;
  const isDeliveredView =
    filters.status === "delivered" || filters.status === "settled";

  // Start independent classification and item-search reads together so the
  // main reservation query does not wait for them one after another.
  const classificationPromise =
    isDeliveredView ||
    filters.status === "reserved" ||
    filters.status === "partially-paid"
      ? supabase.rpc(
          isDeliveredView
            ? "get_fully_delivered_reservation_ids"
            : "get_partially_paid_reservation_ids",
        )
      : Promise.resolve({ data: null, error: null });
  const itemMatchPromise = search
    ? supabase
        .from("reservation_items")
        .select("reservation_id")
        .or(
          "sku.ilike.%" +
            search +
            "%,item_name.ilike.%" +
            search +
            "%",
        )
    : Promise.resolve({ data: [] as Array<{ reservation_id: string }> });
  const [classificationResult, itemMatchResult] = await Promise.all([
    classificationPromise,
    itemMatchPromise,
  ]);
  const classificationIds = classificationResult.data;
  const classificationError = classificationResult.error;
  const classificationIdList = classificationIds ?? [];
  const itemMatchIds = [
    ...new Set((itemMatchResult.data ?? []).map((item) => item.reservation_id)),
  ];

  let query = supabase.from("reservation_list").select("*", { count: "exact" });

  if (isDeliveredView) {
    // Delivered means every item has been released. A first release sets
    // delivered_at, but partially released orders remain in Partially Paid.
    query = query.in(
      "id",
      classificationIdList.length > 0
        ? classificationIdList
        : ["00000000-0000-0000-0000-000000000000"],
    );
    if (filters.status === "settled") {
      query = query.eq("balance", 0);
    }
  } else if (filters.status === "reserved") {
    query = query.eq("status", "reserved").is("delivered_at", null);
    if (classificationIdList.length > 0) {
      query = query.not(
        "id",
        "in",
        "(" +
          classificationIdList.map((id) => '"' + id + '"').join(",") +
          ")",
      );
    }
  } else if (filters.status === "partially-paid") {
    // Partial payment is a derived state: the reservation must still be
    // Reserved, have an active payment, and retain a balance.
    query = query
      .eq("status", "reserved")
      .gt("balance", 0)
      .in(
        "id",
        classificationError || classificationIdList.length === 0
          ? ["00000000-0000-0000-0000-000000000000"]
          : classificationIdList,
      );
  } else if (filters.status === "paid") {
    // Delivery is tracked independently from the financial status. A delivered
    // reservation can therefore still have status = "paid"; keep it out of
    // the Paid tab once its delivery timestamp has been recorded.
    query = query.eq("status", "paid").is("delivered_at", null);
  } else if (filters.status === "cancelled") {
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
      : isDeliveredView
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
  const reservationsPromise = isAll
    ? orderedQuery.limit(2000)
    : orderedQuery.range(from, to ?? from + PAGE_SIZE - 1);
  const [
    { data: reservations, count, error },
    profile,
  ] = await Promise.all([reservationsPromise, profilePromise]);
  const canWrite = roleCanWrite(profile?.role);
  const isAdmin = roleIsAdmin(profile?.role);

  const reservationIds = (reservations ?? []).map(
    (reservation) => reservation.id,
  );
  const resMap = new Map((reservations ?? []).map((r) => [r.id, r]));
  const itemsByReservation = new Map<string, ReservationItemSummary[]>();
  const releasedValueByReservation = new Map<string, number>();
  const remainingValueByReservation = new Map<string, number>();
  const downpaymentAppliedByReservation = new Map<string, number>();
  const activePaidByReservation = new Map<string, number>();
  if (reservationIds.length) {
    // These reads are independent, so avoid waiting for one network round trip
    // before starting the other.
    const [
      { data: reservationItems },
      { data: shipments },
      { data: paymentRows },
    ] = await Promise.all([
      supabase
        .from("reservation_items")
        .select("id, reservation_id, sku, item_name, category, quantity, unit_price, discount")
        .in("reservation_id", reservationIds)
        .order("created_at"),
      supabase
        .from("reservation_shipments")
        .select(
          "id, reservation_id, status, downpayment_applied, reservation_shipment_items(reservation_item_id, quantity)",
        )
        .in("reservation_id", reservationIds)
        .eq("status", "shipped"),
      supabase
        .from("reservation_payments")
        .select("reservation_id, amount")
        .in("reservation_id", reservationIds)
        .is("voided_at", null),
    ]);

    for (const payment of paymentRows ?? []) {
      activePaidByReservation.set(
        payment.reservation_id,
        (activePaidByReservation.get(payment.reservation_id) ?? 0) +
          Number(payment.amount),
      );
    }

    const shippedResIds = new Set((shipments ?? []).map((s) => s.reservation_id));
    for (const s of shipments ?? []) {
      downpaymentAppliedByReservation.set(
        s.reservation_id,
        (downpaymentAppliedByReservation.get(s.reservation_id) ?? 0) + Number(s.downpayment_applied ?? 0),
      );
    }

    const shippedByItem = new Map<string, number>();
    for (const shipment of shipments ?? []) {
      for (const shipmentItem of shipment.reservation_shipment_items ?? []) {
        shippedByItem.set(
          shipmentItem.reservation_item_id,
          (shippedByItem.get(shipmentItem.reservation_item_id) ?? 0) +
            Number(shipmentItem.quantity),
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

      // Released quantities belong in Delivered, never in Reserved or Paid.
      // Keep a partially released line visible while it still has an unreleased
      // quantity, but remove it once the full line has shipped.
      if (
        (filters.status === "reserved" ||
          filters.status === "partially-paid" ||
          filters.status === "paid") &&
        remainingQty <= 0
      ) {
        continue;
      }
      // On the Delivered tab, show released items for an explicitly delivered
      // reservation. For a delivered reservation without shipment records,
      // retain the reservation items as the delivered record.
      if (isDeliveredView) {
        if (shippedResIds.has(item.reservation_id)) {
          if (shippedQty <= 0) continue;
        } else if (resMap.get(item.reservation_id)?.delivered_at == null) {
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
    (filters.status === "reserved" ||
      filters.status === "partially-paid" ||
      filters.status === "paid");
  const queryValues = {
    liveBatch: filters.liveBatch || undefined,
    fromDate: filters.fromDate || undefined,
    toDate: filters.toDate || undefined,
    status: filters.status,
    archive: filters.archive,
    pageSize: filters.pageSize !== "10" ? filters.pageSize : undefined,
    sort: sortColumn,
    direction: filters.direction,
  };
  const visibleReservations = (reservations ?? []).filter(
    (reservation) =>
      (filters.status !== "paid" && filters.status !== "partially-paid") ||
      (itemsByReservation.get(reservation.id)?.length ?? 0) > 0,
  );
  const bulkSelectionRows = bulkEnabled
    ? visibleReservations.map((reservation) => ({
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
  const customerGroupKeyById = new Map<string, string>();
  const customerGroupKeyByIdentity = new Map<string, string>();

  function normalizeCustomerPart(value: string | null | undefined) {
    return (value ?? "")
      .normalize("NFKC")
      .trim()
      .replace(/\s+/g, " ")
      .toLocaleLowerCase();
  }

  for (const reservation of visibleReservations) {
    let resTotal = Number(reservation.total);
    let resPaid = activePaidByReservation.get(reservation.id) ?? 0;
    let resDownpayment = 0;
    let resBalance = Number(reservation.balance);

    if (isDeliveredView) {
      // In delivered view: if this reservation had partial releases, show the released goods value,
      // the downpayment applied to those released shipments, and the remaining balance on them.
      const hasShipments = downpaymentAppliedByReservation.has(reservation.id) || (releasedValueByReservation.get(reservation.id) ?? 0) > 0;
      resDownpayment = downpaymentAppliedByReservation.get(reservation.id) ?? 0;
      if (hasShipments) {
        resTotal = releasedValueByReservation.get(reservation.id) ?? 0;
        if (filters.status === "settled") {
          resPaid = resTotal;
          resBalance = 0;
        } else {
          resPaid = resDownpayment;
          resBalance = Math.max(resTotal - resPaid, 0);
        }
      } else if (reservation.delivered_at == null) {
        // A reservation without released items still belongs in Delivered only
        // when the user explicitly marked that reservation as delivered.
        continue;
      }
    } else if (
      filters.status === "reserved" ||
      filters.status === "partially-paid"
    ) {
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
      filters.status === "reserved" ||
      filters.status === "partially-paid" ||
      filters.status === "paid";
    let normalizedKey = reservation.id;
    if (compileByCustomer) {
      const customerIdKey = "customer:" + reservation.customer_id;
      const customerName = normalizeCustomerPart(reservation.customer_name);
      const customerPhone = normalizeCustomerPart(reservation.customer_phone).replace(
        /\D/g,
        "",
      );
      const customerIdentityKey =
        customerName && customerPhone
          ? "identity:" + customerName + ":" + customerPhone
          : null;

      // Keep the customer id as the primary identity. The name-and-phone
      // fallback only connects duplicate customer records when both fields
      // match exactly after normalization.
      normalizedKey =
        customerGroupKeyById.get(reservation.customer_id) ??
        (customerIdentityKey
          ? customerGroupKeyByIdentity.get(customerIdentityKey)
          : undefined) ??
        customerIdKey;
      customerGroupKeyById.set(reservation.customer_id, normalizedKey);
      if (customerIdentityKey) {
        customerGroupKeyByIdentity.set(customerIdentityKey, normalizedKey);
      }
    }

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

  const reservationRecordCount = visibleReservations.length;
  const tableRowCount = customerGroups.length;

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
        key={search}
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
          Showing <strong className="text-ink">{tableRowCount}</strong> of{" "}
          <strong className="text-ink">{totalCount}</strong> matching reservation{totalCount === 1 ? "" : "s"}
          {reservationRecordCount !== tableRowCount && (
            <span> ({reservationRecordCount} reservation record{reservationRecordCount === 1 ? "" : "s"} grouped on this page)</span>
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
        ) : !visibleReservations.length ? (
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
                    {isDeliveredView && (
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
                          ) : filters.status === "settled" ? (
                            <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-bold text-emerald-700">
                              Settled
                            </span>
                          ) : filters.status === "partially-paid" ? (
                            <span className="rounded-full bg-sky-50 px-2.5 py-1 text-xs font-bold text-sky-700">
                              Partially Paid
                            </span>
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
                                        (isDeliveredView ? "?view=delivered" : "")
                                      }
                                    >
                                      {isDeliveredView ? "View order" : "View Reservation"}
                                    </Link>
                                    {!isDeliveredView && (
                                      <Link className="text-gold-dark" href={"/reservations/" + reservation.id + "/invoice"}>
                                        View Invoice
                                      </Link>
                                    )}
                                    {filters.status === "delivered" && canWrite && !reservation.archived_at && reservation.status === "reserved" && Number(reservation.balance) > 0 && (
                                      <>
                                        <ReservationActionsSeparator />
                                        <Link className="text-emerald-700" href={"/reservations/bulk/pay?ids=" + reservation.id + "&mode=settle"}>
                                          Settle Payment
                                        </Link>
                                      </>
                                    )}
                                    {!isDeliveredView && (
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
                    {(filters.status === "reserved" ||
                      filters.status === "partially-paid") && (
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
