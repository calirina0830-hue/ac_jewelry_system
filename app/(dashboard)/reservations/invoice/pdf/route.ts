import { NextResponse, type NextRequest } from "next/server";

import { logActivity } from "@/lib/activity";
import { authorizeRoles } from "@/lib/auth";
import { buildCustomerInvoiceDocDefinition } from "@/lib/reservations/customer-invoice-document";
import { loadCustomerInvoice } from "@/lib/reservations/customer-invoice";
import { selectCustomerInvoiceItems } from "@/lib/reservations/customer-invoice-selection";
import { renderPdf } from "@/lib/reservations/pdf";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function safeFilename(customerName: string) {
  return (
    customerName
      .normalize("NFKC")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || "customer"
  );
}

export async function GET(request: NextRequest) {
  const authorization = await authorizeRoles(["admin", "staff", "viewer"]);
  if (!authorization) {
    return NextResponse.json({ error: "Not authorized." }, { status: 403 });
  }

  const customerName = request.nextUrl.searchParams.get("customer")?.trim() ?? "";
  if (!customerName) {
    return NextResponse.json({ error: "Customer not found." }, { status: 404 });
  }

  const supabase = await createClient();
  const invoice = await loadCustomerInvoice(supabase, customerName);
  if (!invoice) {
    return NextResponse.json({ error: "Customer invoice not found." }, { status: 404 });
  }

  const rawItemIds = request.nextUrl.searchParams.get("items");
  const selectedItemIds = rawItemIds
    ? rawItemIds
        .split(",")
        .filter((itemId) => /^[0-9a-f-]{36}$/i.test(itemId))
    : undefined;
  const selectedInvoice = selectCustomerInvoiceItems(invoice, selectedItemIds);

  const buffer = await renderPdf(buildCustomerInvoiceDocDefinition(selectedInvoice));
  await logActivity(supabase, {
    action: "invoice_pdf_downloaded",
    entityType: "customer",
    description: "Downloaded compiled customer invoice PDF for " + selectedInvoice.customerName + ".",
    metadata: {
      customer_name: selectedInvoice.customerName,
      selected_item_count: selectedInvoice.items.length,
    },
  });

  const inline = request.nextUrl.searchParams.get("view") === "print";
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Disposition":
        (inline ? "inline" : "attachment") +
        '; filename="' +
        safeFilename(invoice.customerName) +
        '-invoice.pdf"',
      "Content-Type": "application/pdf",
    },
  });
}
