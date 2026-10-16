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
import { loadPaymentTransactionSummaries } from "@/lib/reservations/payment-transaction-data";
import { createClient } from "@/lib/supabase/server";
import { paymentBatchIdsSchema } from "@/lib/validation/payments";

export const metadata: Metadata = { title: "Record Reservation Payments" };

const ERROR_MESSAGES: Record<string, string> = {
  "invalid-payment": "Review every payment amount and field.",
  "invalid-evidence": "Evidence must be a valid JPEG, PNG, or WebP image up to 5 MB.",
  "too-many-evidence": "Upload no more than 5 evidence images per payment.",
  "evidence-upload-failed": "Payment evidence could not be uploaded.",
  "pricing-incomplete": "Complete item pricing before recording a payment.",
  overpayment: "Total payments cannot exceed the value of the reservation items after discounts.",
  "deduction-exceeds-paid": "A deduction cannot exceed the total already paid.",
  "stale-reservation": "A reservation changed after this page loaded. Reload and review it.",
  "payment-failed": "No payments were recorded. Review the entries and try again.",
};

export default async function BulkPaymentPage({
  searchParams,
}: {
  searchParams: Promise<{
    ids?: string | string[];
    error?: string;
    mode?: string;
  }>;
}) {
  const query = await searchParams;
  const isSettlement = query.mode === "settle";
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
    .select("id, reservation_no, customer_id, total, discount, downpayment, balance, pricing_complete, status, archived_at, delivered_at, updated_at")
    .in("id", idsResult.data);
  if (
    !reservations ||
    reservations.length !== idsResult.data.length ||
    reservations.some(
      (item) =>
        !canRecordReservationPayment(item) ||
        (isSettlement && !item.delivered_at),
    )
  ) {
    redirect("/reservations?status=reserved&error=invalid-bulk-selection");
  }

  const customerIds = [...new Set(reservations.map((item) => item.customer_id))];
  const [{ data: customers }, transactionByReservation] = await Promise.all([
    supabase
      .from("customers")
      .select("id, name, facebook_name")
      .in("id", customerIds),
    loadPaymentTransactionSummaries(supabase, reservations),
  ]);
  const customerById = new Map((customers ?? []).map((item) => [item.id, item]));
  if (
    !isSettlement && reservations.some(
      (reservation) =>
        (transactionByReservation.get(reservation.id)?.remainingBalance ?? 0) <=
        0,
    )
  ) {
    redirect("/reservations?status=reserved&error=invalid-bulk-selection");
  }
  const ordered = idsResult.data
    .map((id) => reservations.find((item) => item.id === id))
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
  return (
    <div className="mx-auto max-w-5xl px-5 py-8 sm:px-8 lg:px-10 lg:py-10">
      <PageHeader
        description={
          isSettlement
            ? "Record the remaining balance for this delivered order."
            : "Record a downpayment or another payment for each reservation. Partial balances remain Reserved."
        }
        eyebrow="Reservation payments"
        title={
          isSettlement
            ? "Settle Delivered Order"
            : ordered.length === 1
              ? "Record Payment"
              : "Bulk Payment Review"
        }
      >
        <Link className="inline-flex h-11 items-center rounded-xl border border-border bg-white px-5 text-sm font-semibold text-ink hover:border-gold" href={isSettlement ? "/reservations?status=delivered" : "/reservations?status=reserved"}>
          {isSettlement ? "Back to Delivered" : "Back to Reserved"}
        </Link>
      </PageHeader>

      {query.error && (
        <div className="mt-6 rounded-2xl border border-red-200 bg-red-50 px-5 py-4 text-sm text-red-800" role="alert">
          {ERROR_MESSAGES[query.error] ?? "The payment could not be recorded."}
        </div>
      )}
      <PaymentUploadForm reservationIds={idsResult.data}>
        <input name="reservationIds" type="hidden" value={JSON.stringify(idsResult.data)} />
        {isSettlement && <input name="paymentMode" type="hidden" value="settle" />}
        {ordered.map((reservation) => {
          const customer = customerById.get(reservation.customer_id);
          const transaction = transactionByReservation.get(reservation.id);
          if (!transaction) return null;
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
                updated_at: reservation.updated_at,
                pricing_complete: reservation.pricing_complete,
                transaction,
              }}
              settlementBalance={isSettlement ? Number(reservation.balance) : undefined}
            />
          );
        })}
        <PaymentFormActions
          cancelHref={isSettlement ? "/reservations?status=delivered" : "/reservations?status=reserved"}
          pricingIncomplete={false}
          reservationCount={ordered.length}
        />
      </PaymentUploadForm>
    </div>
  );
}
