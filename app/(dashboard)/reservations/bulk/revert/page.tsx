import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { bulkRevertPaidReservations } from "@/actions/reservations";
import { PageHeader } from "@/components/ui/page-header";
import { getCurrentProfile, roleIsAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { paymentBatchIdsSchema } from "@/lib/validation/payments";

export const metadata: Metadata = { title: "Revert Paid Reservations" };

export default async function RevertPaidReservationsPage({
  searchParams,
}: {
  searchParams: Promise<{ ids?: string }>;
}) {
  const profile = await getCurrentProfile();
  if (!roleIsAdmin(profile?.role)) {
    redirect("/reservations?status=paid&error=not-authorized");
  }
  const query = await searchParams;
  const parsed = paymentBatchIdsSchema.safeParse(
    (query.ids ?? "").split(",").filter(Boolean),
  );
  if (!parsed.success) {
    redirect("/reservations?status=paid&error=invalid-bulk-selection");
  }

  const supabase = await createClient();
  const { data: reservations } = await supabase
    .from("reservations")
    .select("id, reservation_no, status, archived_at")
    .in("id", parsed.data);
  if (
    !reservations ||
    reservations.length !== parsed.data.length ||
    reservations.some((item) => item.status !== "paid" || item.archived_at)
  ) {
    redirect("/reservations?status=paid&error=invalid-bulk-selection");
  }

  return (
    <div className="mx-auto max-w-3xl px-5 py-8 sm:px-8 lg:px-10 lg:py-10">
      <PageHeader
        description="Associated non-voided payments will be voided, never deleted. Inventory remains committed because each order returns to Reserved."
        eyebrow="Admin-only correction"
        title="Revert Paid to Reserved"
      />
      <section className="relative z-10 mt-7 rounded-3xl border border-red-200 bg-white p-6 shadow-card">
        <p className="text-sm font-bold text-red-800">
          Reverting {reservations.length} Paid reservation(s):{" "}
          {reservations.map((item) => item.reservation_no).join(", ")}
        </p>
        <form action={bulkRevertPaidReservations} className="mt-5">
          <input name="reservationIds" type="hidden" value={JSON.stringify(parsed.data)} />
          <label className="relative z-10 block text-sm font-semibold text-ink">
            Reason for reverting to Reserved
            <textarea className="relative z-10 mt-2 min-h-32 w-full pointer-events-auto rounded-xl border border-border bg-white px-4 py-3 font-normal outline-none focus:border-gold focus:ring-4 focus:ring-gold/10" maxLength={1000} minLength={3} name="reason" placeholder="Payment was recorded against the wrong reservation." required />
          </label>
          <div className="mt-5 flex flex-wrap gap-3">
            <button className="rounded-xl bg-red-700 px-6 py-3 text-sm font-bold text-white" type="submit">
              Void Payments and Revert to Reserved
            </button>
            <Link className="rounded-xl border border-border px-5 py-3 text-sm font-semibold text-ink" href="/reservations?status=paid">Cancel</Link>
          </div>
        </form>
      </section>
    </div>
  );
}
