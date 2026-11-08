import Link from "next/link";

import { ReservationForm } from "@/components/reservations/reservation-form";
import type {
  ReservationCustomerOption,
  ReservationInitialValue,
} from "@/types/reservations";

/**
 * Floating edit window over the reservations list. The window always fits the
 * screen: only the item list scrolls, and only when an order is too long.
 * It closes through × or Cancel only, so a stray click cannot lose edits.
 */
export function ReservationEditModal({
  initialValue,
  customers,
  closeHref,
  optionsFailed,
  orderTabs,
  customerOrders,
}: {
  initialValue: ReservationInitialValue;
  customers: ReservationCustomerOption[];
  closeHref: string;
  optionsFailed: boolean;
  // Shown when the customer has more than one editable order.
  orderTabs: Array<{ id: string; href: string; label: string }>;
  customerOrders?: {
    ids: string[];
    paid: string;
    otherOrdersTotalCents: number;
  };
}) {
  return (
    <div
      aria-label="Edit order"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3 backdrop-blur-[1px] sm:p-6"
      role="dialog"
    >
      <div className="flex max-h-[calc(100dvh-1.5rem)] w-full max-w-4xl flex-col rounded-2xl border border-border bg-white shadow-2xl sm:max-h-[calc(100dvh-3rem)]">
        <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border px-5 py-3">
          <h2 className="font-serif text-xl text-ink">Edit order</h2>
          <Link
            aria-label="Close without saving"
            className="inline-flex size-9 items-center justify-center rounded-full text-xl leading-none text-muted transition hover:bg-canvas hover:text-ink"
            href={closeHref}
            scroll={false}
            title="Close without saving"
          >
            ×
          </Link>
        </header>
        {orderTabs.length > 1 && (
          <nav aria-label="Customer orders" className="flex shrink-0 gap-1 px-5 pt-3">
            {orderTabs.map((tab) => (
              <Link
                aria-current={tab.id === initialValue.id ? "page" : undefined}
                className={
                  "rounded-lg px-3 py-1.5 text-xs font-bold transition " +
                  (tab.id === initialValue.id
                    ? "bg-gold-soft text-gold-dark"
                    : "text-muted hover:bg-canvas hover:text-ink")
                }
                href={tab.href}
                key={tab.id}
                scroll={false}
              >
                {tab.label}
              </Link>
            ))}
          </nav>
        )}
        {optionsFailed && (
          <p
            className="mx-5 mt-3 shrink-0 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900"
            role="alert"
          >
            Customer details could not be fully loaded. Reload before
            saving changes.
          </p>
        )}
        <div className="flex min-h-0 flex-auto flex-col px-5 pt-3">
          <ReservationForm
            cancelHref={closeHref}
            customerOrders={customerOrders}
            customers={customers}
            initialValue={initialValue}
            mode="modal"
            returnTo={closeHref}
          />
        </div>
      </div>
    </div>
  );
}
