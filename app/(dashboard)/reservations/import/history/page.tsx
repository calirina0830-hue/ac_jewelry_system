import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { getCurrentProfile, roleIsAdmin } from "@/lib/auth";
import { formatCurrency, formatDateTime } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Live Import History" };

export default async function LiveImportHistoryPage() {
  const profile = await getCurrentProfile();
  if (!roleIsAdmin(profile?.role)) {
    redirect("/reservations?error=Only administrators can inspect import history.");
  }

  const supabase = await createClient();
  const { data: batches, error } = await supabase
    .from("reservation_import_batches")
    .select("*")
    .order("confirmed_at", { ascending: false })
    .limit(200);
  const importerIds = [...new Set((batches ?? []).flatMap((batch) => batch.imported_by ? [batch.imported_by] : []))];
  const { data: profiles } = importerIds.length
    ? await supabase.from("profiles").select("id, full_name").in("id", importerIds)
    : { data: [] };
  const names = new Map((profiles ?? []).map((item) => [item.id, item.full_name]));

  return (
    <div className="mx-auto max-w-[1450px] px-5 py-8 sm:px-8 lg:px-10 lg:py-10">
      <PageHeader
        description="Confirmed Live Selling batches. Raw spreadsheets are not retained."
        eyebrow="Reservations"
        title="Import History"
      >
        <Link className="inline-flex h-11 items-center rounded-xl border border-border bg-white px-5 text-sm font-semibold text-ink hover:border-gold" href="/reservations/import">
          Import Live Orders
        </Link>
      </PageHeader>

      <section className="mt-8 overflow-hidden rounded-3xl border border-border bg-white shadow-card">
        {error ? (
          <div className="px-6 py-12 text-center text-sm text-red-700">
            Import history is unavailable. Confirm the Live Selling migration is applied.
          </div>
        ) : batches?.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] border-collapse text-left">
              <thead className="bg-canvas text-[11px] uppercase tracking-[0.12em] text-muted">
                <tr>
                  {["File Name", "Imported By", "Imported At", "Rows", "Reservations", "Quantity", "Reserved Value"].map((label) => (
                    <th className="px-5 py-4 font-bold" key={label}>{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {batches.map((batch) => (
                  <tr key={batch.id}>
                    <td className="max-w-[260px] truncate px-5 py-4 text-sm font-semibold text-ink" title={batch.original_file_name}>{batch.original_file_name}</td>
                    <td className="px-5 py-4 text-sm text-ink">{batch.imported_by ? names.get(batch.imported_by) ?? "Unknown user" : "Deleted user"}</td>
                    <td className="whitespace-nowrap px-5 py-4 text-sm text-muted">{formatDateTime(batch.confirmed_at)}</td>
                    <td className="px-5 py-4 text-sm text-ink">{batch.row_count}</td>
                    <td className="px-5 py-4 text-sm text-ink">{batch.reservation_count}</td>
                    <td className="px-5 py-4 text-sm text-ink">{batch.item_count}</td>
                    <td className="whitespace-nowrap px-5 py-4 text-sm font-bold text-ink">{formatCurrency(Number(batch.total_value))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No confirmed imports" description="Successful Live Selling imports will appear here." />
        )}
      </section>
    </div>
  );
}
