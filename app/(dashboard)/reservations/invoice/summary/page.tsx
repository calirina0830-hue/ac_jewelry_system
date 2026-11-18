import Link from "next/link";
import { notFound } from "next/navigation";

import { InvoiceSummarySheet } from "@/components/reservations/invoice-summary-sheet";
import { PrintButton } from "@/components/reservations/print-button";
import { requireUser } from "@/lib/auth";
import { loadCustomerInvoice } from "@/lib/reservations/customer-invoice";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function InvoiceSummaryPage({
  searchParams,
}: {
  searchParams: Promise<{ customer?: string }>;
}) {
  const { customer } = await searchParams;
  const customerName = customer?.trim() ?? "";
  if (!customerName) notFound();

  await requireUser();
  const supabase = await createClient();
  const invoice = await loadCustomerInvoice(supabase, customerName);
  if (!invoice) notFound();

  const backHref =
    "/reservations?invoiceCustomer=" + encodeURIComponent(invoice.customerName);
  const buttonClass =
    "inline-flex h-10 items-center rounded-xl border border-border bg-white px-4 text-sm font-semibold text-ink transition hover:border-gold hover:text-gold-dark";

  return (
    <div className="px-4 py-6 sm:px-8" data-print-page>
      <div
        className="mx-auto mb-4 flex max-w-[860px] flex-wrap items-center justify-between gap-2"
        data-print-hide
      >
        <Link className={buttonClass} href={backHref}>
          ← Back to invoice
        </Link>
        <PrintButton
          className="inline-flex h-10 items-center rounded-xl bg-gold px-4 text-sm font-semibold text-white transition hover:bg-gold-dark"
        />
      </div>
      <InvoiceSummarySheet generatedAt={new Date()} invoice={invoice} />
    </div>
  );
}
