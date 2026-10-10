import { NextResponse, type NextRequest } from "next/server";

import { logActivity } from "@/lib/activity";
import { authorizeRoles } from "@/lib/auth";
import { createCsv } from "@/lib/export/csv";
import { filterStockExportRows } from "@/lib/export/filters";
import { sanitizeSearchTerm } from "@/lib/query";
import { createClient } from "@/lib/supabase/server";
import { stockQuerySchema } from "@/lib/validation/stock";
import type { Database } from "@/types/database";

const EXPORT_PAGE_SIZE = 1000;
const HEADERS = ["SKU", "Jewelry Name", "Category", "Status"] as const;

type StockRow = Pick<
  Database["public"]["Tables"]["stock_items"]["Row"],
  "sku" | "name" | "category" | "is_active" | "archived_at"
>;

export async function GET(request: NextRequest) {
  const authorization = await authorizeRoles(["admin", "staff"]);
  if (!authorization) {
    return NextResponse.json({ error: "Not authorized." }, { status: 403 });
  }

  const rawParams = Object.fromEntries(request.nextUrl.searchParams);
  const filters = stockQuerySchema.parse(rawParams);
  const supabase = await createClient();
  const sourceRows: StockRow[] = [];

  for (let from = 0; ; from += EXPORT_PAGE_SIZE) {
    const { data, error } = await supabase
      .from("stock_items")
      .select("sku, name, category, is_active, archived_at")
      .order(filters.sort, { ascending: filters.direction === "asc" })
      .range(from, from + EXPORT_PAGE_SIZE - 1);

    if (error) {
      return NextResponse.json(
        { error: "Stock could not be exported." },
        { status: 500 },
      );
    }

    sourceRows.push(...(data ?? []));
    if (!data || data.length < EXPORT_PAGE_SIZE) break;
  }

  const rows = filterStockExportRows(sourceRows, {
    q: sanitizeSearchTerm(filters.q),
    category: filters.category,
    status: filters.status,
  });
  const csv = createCsv(
    HEADERS,
    rows.map((row) => [
      row.sku,
      row.name,
      row.category,
      row.archived_at ? "Archived" : row.is_active ? "Active" : "Inactive",
    ]),
  );

  await logActivity(supabase, {
    action: "csv_exported",
    entityType: "export",
    description: "Exported " + rows.length + " stock row(s) to CSV.",
    metadata: { export_type: "stock", row_count: rows.length },
  });

  return new NextResponse(csv, {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Disposition": 'attachment; filename="stock.csv"',
      "Content-Type": "text/csv; charset=utf-8",
    },
  });
}
