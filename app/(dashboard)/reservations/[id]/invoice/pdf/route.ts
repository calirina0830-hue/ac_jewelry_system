import { NextResponse, type NextRequest } from "next/server";

import { logActivity } from "@/lib/activity";
import { authorizeRoles } from "@/lib/auth";
import { buildInvoiceDocDefinition } from "@/lib/reservations/invoice-document";
import { loadInvoiceDocument } from "@/lib/reservations/invoice-data";
import { renderPdf } from "@/lib/reservations/pdf";
import { createClient } from "@/lib/supabase/server";
import { reservationIdSchema } from "@/lib/validation/reservations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authorization = await authorizeRoles(["admin", "staff", "viewer"]);
  if (!authorization) {
    return NextResponse.json({ error: "Not authorized." }, { status: 403 });
  }

  const { id } = await params;
  const parsedId = reservationIdSchema.safeParse(id);
  if (!parsedId.success) {
    return NextResponse.json({ error: "Reservation not found." }, { status: 404 });
  }

  const supabase = await createClient();
  const invoice = await loadInvoiceDocument(supabase, parsedId.data);
  if (!invoice) {
    return NextResponse.json({ error: "Reservation not found." }, { status: 404 });
  }

  const buffer = await renderPdf(buildInvoiceDocDefinition(invoice.document));

  await logActivity(supabase, {
    action: "invoice_pdf_downloaded",
    entityType: "reservation",
    entityId: parsedId.data,
    description:
      "Downloaded invoice PDF " + invoice.reservationNo + ".",
  });

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Disposition":
        'attachment; filename="' + invoice.reservationNo + '-invoice.pdf"',
      "Content-Type": "application/pdf",
    },
  });
}
