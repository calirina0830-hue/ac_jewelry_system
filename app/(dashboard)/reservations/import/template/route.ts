import { NextResponse } from "next/server";

import { authorizeRoles } from "@/lib/auth";
import { createCsv } from "@/lib/export/csv";
import { LIVE_IMPORT_HEADERS } from "@/lib/import/live-orders";

export async function GET() {
  const authorized = await authorizeRoles(["admin", "staff"]);
  if (!authorized) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const csv = createCsv(LIVE_IMPORT_HEADERS, []);
  return new NextResponse(csv, {
    headers: {
      "Content-Disposition": 'attachment; filename="amc-live-orders-template.csv"',
      "Content-Type": "text/csv; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
