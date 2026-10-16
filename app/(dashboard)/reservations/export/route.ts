import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";

import { logActivity } from "@/lib/activity";
import { authorizeRoles } from "@/lib/auth";
import { createCsv } from "@/lib/export/csv";
import { filterReservationExportRows } from "@/lib/export/filters";
import { formatDate } from "@/lib/format";
import {
  PRIVATE_SEARCH_COOKIE_NAMES,
  readPrivateSearchTerm,
} from "@/lib/private-search";
import { getInvoiceStatusLabel } from "@/lib/reservations/invoice";
import { createClient } from "@/lib/supabase/server";
import { reservationQuerySchema } from "@/lib/validation/reservations";
import type { Database } from "@/types/database";

const EXPORT_PAGE_SIZE = 1000;
const DETAIL_BATCH_SIZE = 100;
const HEADERS = [
  "Reservation No.",
  "Customer Name",
  "Facebook / CS Name",
  "Status",
  "Items",
  "Total",
  "Downpayment",
  "Balance",
  "Reserved Date",
  "Paid Date",
  "Delivered Date",
  "Cancelled Date",
] as const;

type ReservationListRow = Pick<
  Database["public"]["Views"]["reservation_list"]["Row"],
  | "id"
  | "reservation_no"
  | "customer_name"
  | "customer_facebook_name"
  | "status"
  | "total"
  | "downpayment"
  | "balance"
  | "reserved_at"
  | "archived_at"
  | "live_batch"
  | "delivered_at"
>;

export async function GET(request: NextRequest) {
  const authorization = await authorizeRoles(["admin", "staff"]);
  if (!authorization) {
    return NextResponse.json({ error: "Not authorized." }, { status: 403 });
  }

  const rawParams = Object.fromEntries(request.nextUrl.searchParams);
  const cookieStore = await cookies();
  const search = readPrivateSearchTerm(
    cookieStore.get(PRIVATE_SEARCH_COOKIE_NAMES.reservations)?.value,
    authorization.user.id,
  );
  const filters = reservationQuerySchema.parse({ ...rawParams, q: search });
  const supabase = await createClient();
  const sourceRows: ReservationListRow[] = [];

  for (let from = 0; ; from += EXPORT_PAGE_SIZE) {
    const { data, error } = await supabase
      .from("reservation_list")
      .select(
        "id, reservation_no, customer_name, customer_facebook_name, status, total, downpayment, balance, reserved_at, archived_at, live_batch, delivered_at",
      )
      .order(filters.sort, { ascending: filters.direction === "asc" })
      .range(from, from + EXPORT_PAGE_SIZE - 1);

    if (error) {
      return NextResponse.json(
        { error: "Reservations could not be exported." },
        { status: 500 },
      );
    }

    sourceRows.push(...(data ?? []));
    if (!data || data.length < EXPORT_PAGE_SIZE) break;
  }

  let partiallyPaidIds: string[] | undefined;
  if (filters.status === "partially-paid") {
    const { data: paymentRows, error: paymentError } = await supabase.rpc(
      "get_partially_paid_reservation_ids",
    );
    if (paymentError) {
      return NextResponse.json(
        { error: "Reservation payments could not be exported." },
        { status: 500 },
      );
    }
    partiallyPaidIds = [...new Set(paymentRows ?? [])];
  }

  let itemMatchIds: string[] | undefined;
  if (search) {
    const { data: itemMatches, error: itemsError } = await supabase
      .from("reservation_items")
      .select("reservation_id")
      .or(
        "sku.ilike.%" +
          search +
          "%,item_name.ilike.%" +
          search +
          "%",
      );
    if (itemsError) {
      return NextResponse.json(
        { error: "Reservations could not be exported." },
        { status: 500 },
      );
    }
    itemMatchIds = [
      ...new Set((itemMatches ?? []).map((item) => item.reservation_id)),
    ];
  }

  const rows = filterReservationExportRows(sourceRows, {
    q: search,
    liveBatch: filters.liveBatch || undefined,
    status: filters.status,
    archive: filters.archive,
    itemMatchIds,
    partiallyPaidIds,
  });
  const datesById = new Map<
    string,
    {
      paid_at: string | null;
      delivered_at: string | null;
      cancelled_at: string | null;
    }
  >();
  const itemsById = new Map<string, string[]>();

  for (let index = 0; index < rows.length; index += DETAIL_BATCH_SIZE) {
    const ids = rows.slice(index, index + DETAIL_BATCH_SIZE).map((row) => row.id);
    const [{ data: dates, error: datesError }, { data: items, error: itemsError }] =
      await Promise.all([
        supabase
          .from("reservations")
          .select("id, paid_at, delivered_at, cancelled_at")
          .in("id", ids),
        supabase
          .from("reservation_items")
          .select("reservation_id, item_name, quantity, created_at")
          .in("reservation_id", ids)
          .order("created_at"),
      ]);

    if (datesError || itemsError) {
      return NextResponse.json(
        { error: "Reservation details could not be exported." },
        { status: 500 },
      );
    }

    dates?.forEach((row) => datesById.set(row.id, row));
    items?.forEach((item) => {
      const current = itemsById.get(item.reservation_id) ?? [];
      current.push(item.item_name + " ×" + item.quantity);
      itemsById.set(item.reservation_id, current);
    });
  }

  const operationalDateColumn =
    filters.status === "paid"
      ? "paid_at"
      : filters.status === "delivered" || filters.status === "settled"
        ? "delivered_at"
        : filters.status === "cancelled"
          ? "cancelled_at"
          : "reserved_at";
  const fromDateIso = filters.fromDate
    ? new Date(filters.fromDate + "T00:00:00+08:00").toISOString()
    : undefined;
  const toDateIso = filters.toDate
    ? new Date(
        new Date(filters.toDate + "T00:00:00+08:00").getTime() + 86_400_000,
      ).toISOString()
    : undefined;
  const datedRows = fromDateIso || toDateIso
    ? rows.filter((row) => {
        const dates = datesById.get(row.id);
        const value =
          operationalDateColumn === "paid_at"
            ? dates?.paid_at ?? row.reserved_at
            : operationalDateColumn === "delivered_at"
              ? dates?.delivered_at ?? row.reserved_at
              : operationalDateColumn === "cancelled_at"
                ? dates?.cancelled_at ?? row.reserved_at
                : row.reserved_at;
        if (!value) return false;
        return (
          (!fromDateIso || value >= fromDateIso) &&
          (!toDateIso || value < toDateIso)
        );
      })
    : rows;

  const csv = createCsv(
    HEADERS,
    datedRows.map((row) => {
      const dates = datesById.get(row.id);
      return [
        row.reservation_no,
        row.customer_name,
        row.customer_facebook_name,
        filters.status === "partially-paid"
          ? "Partially Paid"
          : filters.status === "settled"
            ? "Settled"
          : getInvoiceStatusLabel(row.status),
        (itemsById.get(row.id) ?? []).join("; "),
        Number(row.total).toFixed(2),
        Number(row.downpayment).toFixed(2),
        Number(row.balance).toFixed(2),
        formatDate(row.reserved_at),
        dates?.paid_at ? formatDate(dates.paid_at) : "",
        dates?.delivered_at ? formatDate(dates.delivered_at) : "",
        dates?.cancelled_at ? formatDate(dates.cancelled_at) : "",
      ];
    }),
  );

  await logActivity(supabase, {
    action: "csv_exported",
    entityType: "export",
    description:
      "Exported " + datedRows.length + " reservation row(s) to CSV.",
    metadata: { export_type: "reservations", row_count: datedRows.length },
  });

  return new NextResponse(csv, {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Disposition": 'attachment; filename="reservations.csv"',
      "Content-Type": "text/csv; charset=utf-8",
    },
  });
}
