import type { Metadata } from "next";
import Link from "next/link";

import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { PageNotice } from "@/components/ui/page-notice";
import { Pagination } from "@/components/ui/pagination";
import { getCurrentProfile } from "@/lib/auth";
import { PAGE_SIZE } from "@/lib/constants/pagination";
import { formatCurrency, formatManilaDateTime } from "@/lib/format";
import { sanitizeSearchTerm, toSearchParams } from "@/lib/query";
import { createClient } from "@/lib/supabase/server";
import { shipmentQuerySchema } from "@/lib/validation/shipments";

export const metadata: Metadata = { title: "Shipments" };

const SHIPMENT_STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  shipped: "Released",
  cancelled: "Cancelled",
};

const SHIPMENT_STATUS_STYLES: Record<string, string> = {
  pending: "bg-amber-50 text-amber-800",
  shipped: "bg-emerald-50 text-emerald-800",
  cancelled: "bg-red-50 text-red-700",
};

const STATUS_TABS = [
  { value: "all", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "shipped", label: "Released" },
  { value: "cancelled", label: "Cancelled" },
] as const;

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

export default async function ShipmentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const rawParams = await searchParams;
  const filters = shipmentQuerySchema.parse(rawParams);
  const search = sanitizeSearchTerm(filters.q);
  const profile = await getCurrentProfile();
  const supabase = await createClient();
  const from = (filters.page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  let query = supabase
    .from("reservation_shipments")
    .select(
      "id, shipment_no, reservation_id, status, downpayment_applied, created_at, shipped_at",
      { count: "exact" },
    );

  if (filters.status !== "all") {
    query = query.eq("status", filters.status);
  }

  if (search) {
    const pattern = "%" + search + "%";
    const { data: matchedReservations } = await supabase
      .from("reservation_list")
      .select("id")
      .or(
        "reservation_no.ilike." +
          pattern +
          ",customer_name.ilike." +
          pattern +
          ",customer_facebook_name.ilike." +
          pattern,
      );
    const matchingIds = (matchedReservations ?? []).map(
      (reservation) => reservation.id,
    );
    query = query.or(
      "shipment_no.ilike." +
        pattern +
        ",reservation_id.in.(" +
        (matchingIds.length ? matchingIds.join(",") : ZERO_UUID) +
        ")",
    );
  }

  const { data: shipments, count, error } = await query
    .order("created_at", { ascending: false })
    .range(from, to);

  const shipmentIds = (shipments ?? []).map((shipment) => shipment.id);
  const reservationIds = (shipments ?? []).map(
    (shipment) => shipment.reservation_id,
  );
  const [
    { data: reservations },
    { data: shipmentItems },
  ] = await Promise.all([
    supabase
      .from("reservation_list")
      .select("id, reservation_no, customer_name")
      .in(
        "id",
        reservationIds.length ? reservationIds : [ZERO_UUID],
      ),
    supabase
      .from("reservation_shipment_items")
      .select("shipment_id, quantity")
      .in("shipment_id", shipmentIds.length ? shipmentIds : [ZERO_UUID]),
  ]);

  const reservationById = new Map(
    (reservations ?? []).map((reservation) => [reservation.id, reservation]),
  );
  const unitsByShipment = new Map<string, number>();
  const itemCountByShipment = new Map<string, number>();
  for (const item of shipmentItems ?? []) {
    unitsByShipment.set(
      item.shipment_id,
      (unitsByShipment.get(item.shipment_id) ?? 0) + Number(item.quantity),
    );
    itemCountByShipment.set(
      item.shipment_id,
      (itemCountByShipment.get(item.shipment_id) ?? 0) + 1,
    );
  }

  const rows = (shipments ?? []).map((shipment) => {
    const reservation = reservationById.get(shipment.reservation_id);
    return {
      id: shipment.id,
      shipmentNo: shipment.shipment_no,
      reservationId: shipment.reservation_id,
      reservationNo: reservation?.reservation_no ?? "—",
      customerName: reservation?.customer_name ?? "—",
      status: shipment.status,
      downpaymentApplied: Number(shipment.downpayment_applied ?? 0),
      createdAt: shipment.created_at,
      shippedAt: shipment.shipped_at,
      itemCount: itemCountByShipment.get(shipment.id) ?? 0,
      units: unitsByShipment.get(shipment.id) ?? 0,
    };
  });

  const pageCount = Math.max(1, Math.ceil((count ?? 0) / PAGE_SIZE));
  const queryValues = {
    q: search || undefined,
    status: filters.status,
  };

  return (
    <div className="mx-auto max-w-[1400px] px-5 py-8 sm:px-8 lg:px-10 lg:py-10">
      <PageHeader
        description="Every item release across all reservations, with the downpayment applied."
        eyebrow="Order management"
        title="Shipments"
      >
        {profile?.role && (
          <Link
            className="inline-flex h-9 items-center rounded-lg px-2 text-sm font-semibold text-muted transition hover:bg-white hover:text-ink"
            href="/reservations"
          >
            &larr; Reservations
          </Link>
        )}
      </PageHeader>
      <PageNotice
        error={
          typeof rawParams.error === "string" ? rawParams.error : undefined
        }
        message={
          typeof rawParams.message === "string" ? rawParams.message : undefined
        }
      />

      <nav
        aria-label="Shipment status views"
        className="mt-6 flex flex-wrap gap-2"
      >
        {STATUS_TABS.map((tab) => {
          const params = toSearchParams({
            q: search || undefined,
            status: tab.value,
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
              href={"/shipments?" + params.toString()}
              key={tab.value}
            >
              {tab.label}
            </Link>
          );
        })}
      </nav>

      <form
        className="mt-6 grid items-end gap-3 rounded-2xl border border-border bg-white p-4 shadow-card sm:grid-cols-[minmax(260px,1fr)_auto_auto]"
        method="get"
      >
        <label className="block" htmlFor="shipment-search">
          <span className="mb-1.5 block text-xs font-bold uppercase leading-4 tracking-[0.1em] text-muted">
            Search
          </span>
          <input
            className="h-11 w-full rounded-xl border border-border px-4 text-sm outline-none focus:border-gold focus:ring-4 focus:ring-gold/10"
            defaultValue={search}
            id="shipment-search"
            name="q"
            placeholder="Shipment no., reservation no., or customer name"
          />
        </label>
        <label className="block" htmlFor="shipment-status">
          <span className="mb-1.5 block text-xs font-bold uppercase leading-4 tracking-[0.1em] text-muted">
            Status
          </span>
          <select
            className="h-11 w-full rounded-xl border border-border bg-white px-4 text-sm outline-none focus:border-gold focus:ring-4 focus:ring-gold/10 sm:w-44"
            defaultValue={filters.status}
            id="shipment-status"
            name="status"
          >
            {STATUS_TABS.map((tab) => (
              <option key={tab.value} value={tab.value}>
                {tab.label}
              </option>
            ))}
          </select>
        </label>
        <button className="h-11 rounded-xl bg-ink px-5 text-sm font-bold text-white transition hover:bg-ink/90" type="submit">
          Apply
        </button>
      </form>

      <section className="mt-6 overflow-hidden rounded-2xl border border-border bg-white shadow-card">
        {error ? (
          <div className="px-6 py-14 text-center text-sm text-red-700" role="alert">
            Shipments could not be loaded. Confirm the Phase 5 migration has
            been applied.
          </div>
        ) : !rows.length ? (
          <EmptyState
            description={
              search
                ? "Try adjusting the search or filters."
                : "Releases appear here as soon as items are shipped to a customer."
            }
            title={
              search ? "No matching shipments" : "No shipments recorded yet"
            }
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1000px] border-collapse text-left">
                <thead className="bg-canvas text-[11px] uppercase tracking-[0.14em] text-muted">
                  <tr>
                    <th className="px-6 py-4 font-bold">Shipment</th>
                    <th className="px-5 py-4 font-bold">Reservation</th>
                    <th className="px-5 py-4 font-bold">Customer</th>
                    <th className="px-5 py-4 font-bold">Items</th>
                    <th className="px-5 py-4 font-bold">Units</th>
                    <th className="px-5 py-4 text-right font-bold">Downpayment</th>
                    <th className="px-5 py-4 font-bold">Status</th>
                    <th className="px-5 py-4 font-bold">Prepared</th>
                    <th className="px-5 py-4 font-bold">Released</th>
                    <th className="w-28 px-5 py-4 text-right font-bold">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.map((shipment) => (
                    <tr className="transition hover:bg-canvas/70" key={shipment.id}>
                      <td className="whitespace-nowrap px-6 py-4 font-bold text-ink">
                        {shipment.shipmentNo}
                      </td>
                      <td className="whitespace-nowrap px-5 py-4">
                        <Link
                          className="font-semibold text-gold-dark hover:underline"
                          href={"/reservations/" + shipment.reservationId}
                        >
                          {shipment.reservationNo}
                        </Link>
                      </td>
                      <td className="whitespace-nowrap px-5 py-4 text-sm font-medium text-ink">
                        {shipment.customerName}
                      </td>
                      <td className="px-5 py-4 text-sm text-muted">
                        {shipment.itemCount}
                      </td>
                      <td className="px-5 py-4 text-sm text-muted">
                        {shipment.units}
                      </td>
                      <td className="whitespace-nowrap px-5 py-4 text-right text-sm font-semibold text-ink">
                        {shipment.downpaymentApplied > 0
                          ? formatCurrency(shipment.downpaymentApplied)
                          : "—"}
                      </td>
                      <td className="px-5 py-4">
                        <span
                          className={
                            "inline-flex rounded-full px-2.5 py-1 text-xs font-bold " +
                            (SHIPMENT_STATUS_STYLES[shipment.status] ??
                              "bg-canvas text-muted")
                          }
                        >
                          {SHIPMENT_STATUS_LABELS[shipment.status] ??
                            shipment.status}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-5 py-4 text-sm text-muted">
                        {formatManilaDateTime(shipment.createdAt)}
                      </td>
                      <td className="whitespace-nowrap px-5 py-4 text-sm text-muted">
                        {shipment.shippedAt
                          ? formatManilaDateTime(shipment.shippedAt)
                          : "—"}
                      </td>
                      <td className="px-5 py-4">
                        <div className="flex justify-end gap-2">
                          <Link
                            className="text-gold-dark"
                            href={"/shipments/" + shipment.id + "/pdf"}
                          >
                            PDF
                          </Link>
                          <Link
                            className="text-ink"
                            href={"/reservations/" + shipment.reservationId}
                          >
                            View
                          </Link>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              page={filters.page}
              pageCount={pageCount}
              pathname="/shipments"
              query={queryValues}
            />
          </>
        )}
      </section>
    </div>
  );
}