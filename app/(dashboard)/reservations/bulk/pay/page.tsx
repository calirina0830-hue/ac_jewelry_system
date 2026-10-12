import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { PaymentFormActions } from "@/components/reservations/payment-form-actions";
import { PaymentUploadForm } from "@/components/reservations/payment-upload-form";
import { RecordPaymentCard } from "@/components/reservations/record-payment-card";
import { PageHeader } from "@/components/ui/page-header";
import { getCurrentProfile, roleCanWrite } from "@/lib/auth";
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
  "deduction-exceeds-paid": "A deduction cannot exceed the total already paid.",
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
            <RecordPaymentCard
              key={reservation.id}
              customer={{
                name: customer?.name ?? null,
                facebook_name: customer?.facebook_name ?? null,
              }}
              reservation={{
                id: reservation.id,
                reservation_no: reservation.reservation_no,
                total: Number(reservation.total),
                downpayment: Number(reservation.downpayment),
                balance: Number(reservation.balance),
                updated_at: reservation.updated_at,
                pricing_complete: reservation.pricing_complete,
              }}
            />
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
