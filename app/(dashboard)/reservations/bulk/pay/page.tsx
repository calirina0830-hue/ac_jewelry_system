import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { PaymentEvidenceInput } from "@/components/reservations/payment-evidence-input";
import { PaymentFormActions } from "@/components/reservations/payment-form-actions";
import { PaymentUploadForm } from "@/components/reservations/payment-upload-form";
import { PageHeader } from "@/components/ui/page-header";
import { getCurrentProfile, roleCanWrite } from "@/lib/auth";
import { formatCurrency } from "@/lib/format";
import { canRecordReservationPayment } from "@/lib/reservations/payment-eligibility";
import { parseBulkPaymentIds } from "@/lib/reservations/payment-selection";
import { createClient } from "@/lib/supabase/server";
import { paymentBatchIdsSchema } from "@/lib/validation/payments";

export const metadata: Metadata = { title: "Record Reservation Payments" };

const ERROR_MESSAGES: Record<string, string> = {
  "invalid-payment": "Review every payment amount and field.",
  "invalid-evidence": "Evidence must be a valid JPEG, PNG, or WebP image up to 5 MB.",
  "too-many-evidence": "Upload no more than 5 evidence images per payment.",
  "evidence-upload-failed": "Payment evidence could not be uploaded.",
  "pricing-incomplete": "Complete item pricing before recording a payment.",
  overpayment: "A payment cannot exceed the reservation's remaining balance.",
  "stale-reservation": "A reservation changed after this page loaded. Reload and review it.",
  "payment-failed": "No payments were recorded. Review the entries and try again.",
};

export default async function BulkPaymentPage({
  searchParams,
}: {
  searchParams: Promise<{ ids?: string | string[]; error?: string }>;
}) {
  const query = await searchParams;
  const profile = await getCurrentProfile();
  if (!roleCanWrite(profile?.role)) {
    redirect("/reservations?status=reserved&error=not-authorized");
  }

  const idsResult = paymentBatchIdsSchema.safeParse(
    parseBulkPaymentIds(query.ids),
  );
  if (!idsResult.success) {
    redirect("/reservations?status=reserved&error=invalid-bulk-selection");
  }

  const supabase = await createClient();
  const { data: reservations } = await supabase
    .from("reservations")
    .select("id, reservation_no, customer_id, total, downpayment, balance, pricing_complete, status, archived_at, updated_at")
    .in("id", idsResult.data);
  if (
    !reservations ||
    reservations.length !== idsResult.data.length ||
    reservations.some((item) => !canRecordReservationPayment(item))
  ) {
    redirect("/reservations?status=reserved&error=invalid-bulk-selection");
  }

  const customerIds = [...new Set(reservations.map((item) => item.customer_id))];
  const { data: customers } = await supabase
    .from("customers")
    .select("id, name, facebook_name")
    .in("id", customerIds);
  const customerById = new Map((customers ?? []).map((item) => [item.id, item]));
  const ordered = idsResult.data
    .map((id) => reservations.find((item) => item.id === id))
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
  return (
    <div className="mx-auto max-w-5xl px-5 py-8 sm:px-8 lg:px-10 lg:py-10">
      <PageHeader
        description="Record a downpayment or another payment for each reservation. Partial balances remain Reserved."
        eyebrow="Reservation payments"
        title={ordered.length === 1 ? "Record Payment" : "Bulk Payment Review"}
      >
        <Link className="inline-flex h-11 items-center rounded-xl border border-border bg-white px-5 text-sm font-semibold text-ink hover:border-gold" href="/reservations?status=reserved">
          Back to Reserved
        </Link>
      </PageHeader>

      {query.error && (
        <div className="mt-6 rounded-2xl border border-red-200 bg-red-50 px-5 py-4 text-sm text-red-800" role="alert">
          {ERROR_MESSAGES[query.error] ?? "The payment could not be recorded."}
        </div>
      )}
      <PaymentUploadForm reservationIds={idsResult.data}>
        <input name="reservationIds" type="hidden" value={JSON.stringify(idsResult.data)} />
        {ordered.map((reservation) => {
          const customer = customerById.get(reservation.customer_id);
          return (
            <section className="rounded-3xl border border-border bg-white p-6 shadow-card" key={reservation.id}>
              <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-5">
                <div>
                  <p className="text-xs font-bold uppercase tracking-[0.15em] text-gold-dark">{reservation.reservation_no}</p>
                  <h2 className="mt-1 font-serif text-2xl text-ink">{customer?.name ?? "Customer unavailable"}</h2>
                  {customer?.facebook_name && <p className="mt-1 text-xs text-muted">Facebook / CS: {customer.facebook_name}</p>}
                </div>
                <div className="grid grid-cols-3 gap-4 text-right">
                  <div>
                    <p className="text-xs text-muted">Reservation total</p>
                    <p className="mt-1 text-sm font-bold text-ink">{formatCurrency(Number(reservation.total))}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted">Current total paid</p>
                    <p className="mt-1 text-sm font-bold text-ink">{formatCurrency(Number(reservation.downpayment))}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted">Current remaining balance</p>
                    <p className="mt-1 text-lg font-black text-ink">{formatCurrency(Number(reservation.balance))}</p>
                  </div>
                </div>
              </div>
              <input name={"updatedAt:" + reservation.id} type="hidden" value={reservation.updated_at} />
              <div className="mt-5 grid gap-5 md:grid-cols-2">
                <label className="block text-sm font-semibold text-ink">
                  Payment amount
                  <input className="mt-2 h-11 w-full rounded-xl border border-border px-4 font-normal outline-none focus:border-gold" defaultValue={Number(reservation.balance).toFixed(2)} inputMode="decimal" max={Number(reservation.balance).toFixed(2)} min="0.01" name={"amount:" + reservation.id} required step="0.01" type="number" />
                </label>
                <label className="block text-sm font-semibold text-ink">
                  Payment method <span className="font-normal text-muted">(optional)</span>
                  <input className="mt-2 h-11 w-full rounded-xl border border-border px-4 font-normal outline-none focus:border-gold" maxLength={120} name={"paymentMethod:" + reservation.id} placeholder="Cash, GCash, bank transfer" />
                </label>
                <label className="block text-sm font-semibold text-ink">
                  Reference number <span className="font-normal text-muted">(optional)</span>
                  <input className="mt-2 h-11 w-full rounded-xl border border-border px-4 font-normal outline-none focus:border-gold" maxLength={200} name={"referenceNo:" + reservation.id} />
                </label>
                <PaymentEvidenceInput key={reservation.id} name={"evidence:" + reservation.id} />
                <label className="block text-sm font-semibold text-ink md:col-span-2">
                  Payment notes <span className="font-normal text-muted">(optional)</span>
                  <textarea className="mt-2 min-h-24 w-full rounded-xl border border-border px-4 py-3 font-normal outline-none focus:border-gold" maxLength={2000} name={"notes:" + reservation.id} />
                </label>
              </div>
              {!reservation.pricing_complete && (
                <Link className="mt-4 inline-flex text-sm font-bold text-gold-dark hover:underline" href={"/reservations/" + reservation.id + "/edit"}>
                  Complete item pricing
                </Link>
              )}
            </section>
          );
        })}
        <PaymentFormActions
          cancelHref="/reservations?status=reserved"
          pricingIncomplete={false}
          reservationCount={ordered.length}
        />
      </PaymentUploadForm>
    </div>
  );
}
