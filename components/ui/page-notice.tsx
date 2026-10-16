const MESSAGES: Record<string, string> = {
  created: "Record created successfully.",
  updated: "Changes saved successfully.",
  archived: "Record archived successfully.",
  restored: "Record restored successfully.",
  deleted: "Archived reservation permanently deleted.",
  "all-deleted": "All archived reservations were permanently deleted.",
  "status-paid": "Reservation marked as paid.",
  "status-delivered": "Reservation marked as delivered.",
  settled: "Payment settled. The order is now listed under Settled Orders.",
  "status-cancelled": "Reservation cancelled and its stock commitment released.",
  "payment-edited": "Payment record corrected. The original entry remains in the audit history.",
  "payment-voided": "Payment voided successfully. The original entry remains in the audit history.",
};

const ERRORS: Record<string, string> = {
  "not-authorized": "You do not have permission to perform that action.",
  "archive-failed": "The record could not be archived. Please try again.",
  "restore-failed": "The record could not be restored. Please try again.",
  "delete-failed": "The archived record could not be deleted. Please try again.",
  "restore-stock-failed":
    "The reservation cannot be restored because one or more items are unavailable.",
  "not-editable": "Only active reserved reservations can be edited.",
  "invalid-transition": "That reservation status change is not allowed.",
  "invalid-bulk-selection":
    "Some selected reservations cannot receive a payment. Review their current status, pricing, and balance.",
  "stale-reservation":
    "This reservation changed in another session. Reload before trying again.",
  "stale-payment": "This payment changed in another session. Reload before trying again.",
  "payment-not-editable": "This payment or reservation can no longer be changed.",
  "payment-downpayment-committed":
    "This payment cannot be removed because its funds are committed to a release.",
  "payment-void-deduction-exceeds-paid":
    "This payment cannot be voided because the remaining payment total would go below zero.",
  "payment-void-downpayment-committed":
    "This payment cannot be voided because its funds are committed to a release.",
  "payment-void-exceeds-total":
    "This payment cannot be voided because it would make total payments exceed the item value.",
  "payment-void-invalid": "Enter a valid reason before voiding this payment.",
  "payment-void-migration-required":
    "Payment voiding is not available yet. Apply the latest database migration, then try again.",
  "payment-void-failed": "The payment could not be voided. Please try again.",
};

export function PageNotice({
  message,
  error,
}: {
  message?: string;
  error?: string;
}) {
  const text = error ? ERRORS[error] : message ? MESSAGES[message] : null;

  if (!text) {
    return null;
  }

  return (
    <div
      className={
        "mt-6 rounded-xl border px-4 py-3 text-sm " +
        (error
          ? "border-red-200 bg-red-50 text-red-800"
          : "border-emerald-200 bg-emerald-50 text-emerald-800")
      }
      role={error ? "alert" : "status"}
    >
      {text}
    </div>
  );
}
