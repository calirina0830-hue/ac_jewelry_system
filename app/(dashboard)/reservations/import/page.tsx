import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { LiveOrderImport } from "@/components/reservations/live-order-import";
import { PageHeader } from "@/components/ui/page-header";
import { getCurrentProfile } from "@/lib/auth";

export const metadata: Metadata = { title: "Import Live Orders" };

export default async function ImportLiveOrdersPage() {
  const profile = await getCurrentProfile();
  if (!profile || !["admin", "staff"].includes(profile.role)) {
    redirect("/reservations?error=You are not allowed to import live orders.");
  }

  return (
    <div className="mx-auto max-w-[1550px] px-5 py-8 sm:px-8 lg:px-10 lg:py-10">
      <PageHeader
        description="Upload Facebook Live Selling orders, validate every row, then create Reserved reservations in one transaction."
        eyebrow="Reservations"
        title="Import Live Orders"
      >
        <Link className="inline-flex h-11 items-center rounded-xl border border-border bg-white px-5 text-sm font-semibold text-ink hover:border-gold" href="/reservations">
          Back to Reservations
        </Link>
        {profile.role === "admin" && (
          <Link className="inline-flex h-11 items-center rounded-xl border border-border bg-white px-5 text-sm font-semibold text-ink hover:border-gold" href="/reservations/import/history">
            Import History
          </Link>
        )}
      </PageHeader>
      <LiveOrderImport />
    </div>
  );
}
