import type { Metadata } from "next";
import Link from "next/link";

import {
  archiveReservation,
  bulkTransitionReservations,
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
import { RESERVATION_STATUS_OPTIONS } from "@/lib/constants/reservations";
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
  const from = (filters.page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  let query = supabase.from("reservation_list").select("*", { count: "exact" });

  if (filters.status === "delivered") {
    query = query.not("delivered_at", "is", null);
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

  const { data: reservations, count, error } = await query
    .order(sortColumn, { ascending: filters.direction === "asc" })
    .range(from, to);

  const reservationIds = (reservations ?? []).map(
    (reservation) => reservation.id,
  );
  const itemsByReservation = new Map<string, ReservationItemSummary[]>();
  if (reservationIds.length) {
    const { data: reservationItems } = await supabase
      .from("reservation_items")
      .select("reservation_id, sku, item_name, category")
      .in("reservation_id", reservationIds)
      .order("created_at");
    for (const item of reservationItems ?? []) {
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

  const pageCount = Math.max(1, Math.ceil((count ?? 0) / PAGE_SIZE));
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
            archive: filters.archive,
            sort: tab.value === filters.status ? sortColumn : undefined,
            direction: filters.direction,
          });
          const active = filters.status === tab.value;

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
          className="rounded-xl border border-border bg-white px-4 py-2.5 text-sm font-bold text-muted hover:border-gold hover:text-ink"
          href="/reservations?status=all&archive=active"
        >
          All active
        </Link>
        <Link
          className={
            "rounded-xl border px-4 py-2.5 text-sm font-bold " +
            (filters.archive === "archived"
              ? "border-stone-700 bg-stone-700 text-white"
              : "border-border bg-white text-muted hover:border-gold hover:text-ink")
          }
          href="/reservations?status=all&archive=archived"
        >
          Archive
        </Link>
      </nav>

      <form
        className="mt-6 grid items-end gap-3 rounded-2xl border border-border bg-white p-4 shadow-card sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-[minmax(300px,1fr)_145px_145px_150px_170px_auto_auto]"
        method="get"
      >
        <label className="block" htmlFor="reservation-search">
          <span className="mb-1.5 block text-xs font-bold uppercase leading-4 tracking-[0.1em] text-muted">
            Search
          </span>
          <input
            className="h-11 w-full rounded-xl border border-border px-4 text-sm outline-none focus:border-gold focus:ring-4 focus:ring-gold/10"
            defaultValue={search}
            id="reservation-search"
            name="q"
            placeholder="Reservation no., customer, FB / CS name, SKU, or item name"
          />
        </label>
        <label className="block" htmlFor="reservation-from-date">
          <span className="mb-1.5 block text-xs font-bold uppercase leading-4 tracking-[0.1em] text-muted">
            From Date
          </span>
          <input className="block h-11 w-full rounded-xl border border-border px-3 text-sm font-normal text-ink outline-none focus:border-gold focus:ring-4 focus:ring-gold/10" defaultValue={filters.fromDate} id="reservation-from-date" name="fromDate" type="date" />
        </label>
        <label className="block" htmlFor="reservation-to-date">
          <span className="mb-1.5 block text-xs font-bold uppercase leading-4 tracking-[0.1em] text-muted">
            To Date
          </span>
          <input className="block h-11 w-full rounded-xl border border-border px-3 text-sm font-normal text-ink outline-none focus:border-gold focus:ring-4 focus:ring-gold/10" defaultValue={filters.toDate} id="reservation-to-date" name="toDate" type="date" />
        </label>
        <label className="block" htmlFor="reservation-status">
          <span className="mb-1.5 block text-xs font-bold uppercase leading-4 tracking-[0.1em] text-muted">
            Status
          </span>
          <select
            className="h-11 w-full rounded-xl border border-border bg-white px-4 text-sm outline-none focus:border-gold focus:ring-4 focus:ring-gold/10"
            defaultValue={filters.status}
            id="reservation-status"
            name="status"
          >
            <option value="all">All statuses</option>
            {RESERVATION_STATUS_OPTIONS.map((status) => (
              <option key={status.value} value={status.value}>
                {status.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block" htmlFor="reservation-archive">
          <span className="mb-1.5 block text-xs font-bold uppercase leading-4 tracking-[0.1em] text-muted">
            Records
          </span>
          <select
            className="h-11 w-full rounded-xl border border-border bg-white px-4 text-sm outline-none focus:border-gold focus:ring-4 focus:ring-gold/10"
            defaultValue={filters.archive}
            id="reservation-archive"
            name="archive"
          >
            <option value="active">Active reservations</option>
            <option value="archived">Archived reservations</option>
            <option value="all">All records</option>
          </select>
        </label>
        <button className="h-11 rounded-xl bg-ink px-5 text-sm font-bold text-white transition hover:bg-ink/90" type="submit">
          Apply
        </button>
        <Link
          className="inline-flex h-11 items-center justify-center rounded-xl border border-border px-4 text-sm font-semibold text-muted transition hover:border-gold hover:text-ink"
          href={
            "/reservations?" +
            toSearchParams({
              status: filters.status,
              archive: filters.archive,
            }).toString()
          }
        >
          Clear
        </Link>
      </form>

      <BulkSelectionProvider rows={bulkSelectionRows}>
      <section className="mt-6 overflow-hidden rounded-2xl border border-border bg-white shadow-card">
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
                  {reservations.map((reservation) => (
                    <tr className="transition hover:bg-canvas/70" key={reservation.id}>
                      {bulkEnabled && (
                        <td className="px-5 py-4">
                          <BulkRowCheckbox
                            label={"Select " + reservation.reservation_no}
                            value={reservation.id}
                          />
                        </td>
                      )}
                      <td className="whitespace-nowrap px-5 py-4">
                        <Link className="font-bold text-gold-dark hover:underline" href={"/reservations/" + reservation.id}>
                          {reservation.reservation_no}
                        </Link>
                      </td>
                      <td className="px-5 py-4">
                        <p className="font-semibold text-ink">{reservation.customer_name}</p>
                        <p className="mt-1 text-xs font-medium text-muted">
                          {reservation.customer_facebook_name
                            ? "Facebook / CS: " + reservation.customer_facebook_name
                            : reservation.customer_phone ?? "No Facebook / CS name"}
                        </p>
                        {reservation.status === "reserved" &&
                          Number(reservation.downpayment) > 0 &&
                          Number(reservation.balance) > 0 && (
                            <span className="mt-1 inline-flex rounded-full bg-sky-50 px-2 py-0.5 text-[10px] font-bold text-sky-700">
                              Partially Paid
                            </span>
                          )}
                      </td>
                      <td className="px-5 py-4">
                        <ReservationItemCell
                          items={itemsByReservation.get(reservation.id) ?? []}
                        />
                      </td>
                      <td className="whitespace-nowrap px-5 py-4 text-sm font-semibold text-ink">{formatCurrency(Number(reservation.total))}</td>
                      <td className="whitespace-nowrap px-5 py-4 text-sm text-muted">{formatCurrency(Number(reservation.downpayment))}</td>
                      <td className="whitespace-nowrap px-5 py-4 text-sm font-bold text-ink">{formatCurrency(Number(reservation.balance))}</td>
                      <td className="px-5 py-4"><ReservationStatus archived={Boolean(reservation.archived_at)} delivered={Boolean(reservation.delivered_at)} status={reservation.status} /></td>
                      <td className="whitespace-nowrap px-5 py-4 text-sm text-muted">
                        {formatDate(
                          operationalDateColumn === "paid_at"
                            ? reservation.paid_at ?? reservation.reserved_at
                            : operationalDateColumn === "delivered_at"
                              ? reservation.delivered_at ?? reservation.reserved_at
                              : operationalDateColumn === "cancelled_at"
                                ? reservation.cancelled_at ?? reservation.reserved_at
                                : reservation.reserved_at,
                        )}
                      </td>
                      <td className="px-5 py-4">
                        <div className="flex justify-end">
                          <ReservationActionsMenu>
                          <Link className="text-gold-dark" href={"/reservations/" + reservation.id}>View Reservation</Link>
                          <Link className="text-gold-dark" href={"/reservations/" + reservation.id + "/invoice"}>View Invoice</Link>
                          {!reservation.archived_at &&
                            ((canWrite && reservation.status === "reserved") ||
                              (isAdmin && reservation.status === "paid")) && (
                            <ReservationActionsSeparator />
                          )}
                          {canWrite && !reservation.archived_at && reservation.status === "reserved" && (
                            canRecordReservationPayment(reservation) ? (
                              <Link className="text-emerald-700" href={"/reservations/bulk/pay?ids=" + reservation.id}>Record Payment</Link>
                            ) : needsReservationPricing(reservation) ? (
                              <Link className="text-amber-700" href={"/reservations/" + reservation.id + "/edit"}>Complete Pricing</Link>
                            ) : null
                          )}
                          {isAdmin && !reservation.archived_at && reservation.status === "paid" && (
                            <Link className="text-red-700" href={"/reservations/bulk/revert?ids=" + reservation.id}>Revert to Reserved</Link>
                          )}
                          {canWrite && !reservation.archived_at && reservation.status === "reserved" && (
                            <Link className="text-ink" href={"/reservations/" + reservation.id + "/edit"}>Edit Reservation</Link>
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
                          {isAdmin && (reservation.archived_at ? (
                            <ConfirmAction action={restoreReservation.bind(null, reservation.id)} confirmation={"Restore " + reservation.reservation_no + " to the active list?"} variant="neutral">Restore</ConfirmAction>
                          ) : (
                            <ConfirmAction action={archiveReservation.bind(null, reservation.id)} confirmation={"Archive " + reservation.reservation_no + "? Its business status and stock commitment will remain unchanged."}>Archive</ConfirmAction>
                          ))}
                          </ReservationActionsMenu>
                        </div>
                      </td>
                    </tr>
                  ))}
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
