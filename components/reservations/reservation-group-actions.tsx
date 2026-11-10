import Link from "next/link";
import { Fragment, type ReactNode } from "react";

import {
  archiveReservation,
  deleteArchivedReservation,
  restoreReservation,
} from "@/actions/reservations";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { needsReservationPricing } from "@/lib/reservations/payment-eligibility";
import { buildBulkPaymentHref } from "@/lib/reservations/payment-selection";
import type { ReservationStatus } from "@/types/database";

type GroupReservation = {
  id: string;
  status: ReservationStatus;
  archived_at: string | null;
  balance: number | string;
  pricing_complete: boolean;
  total: number | string;
  updated_at: string;
};

const linkClass = "font-semibold hover:underline";

/**
 * Row actions for one customer: only the everyday one-click actions.
 * Payments are recorded from the Edit window. Everything else (releasing,
 * printing, cancel/archive...) is in the customer's invoice panel, opened by
 * "Open" or by clicking the customer name.
 */
export function GroupActions({
  reservations,
  canWrite,
  isDeliveredView,
  invoiceHref,
  editHrefFor,
  customerName,
}: {
  reservations: GroupReservation[];
  editHrefFor: (reservationId: string) => string;
  canWrite: boolean;
  isDeliveredView: boolean;
  invoiceHref: string;
  customerName: string;
}) {
  const active = reservations.filter((r) => !r.archived_at);
  const settleable = isDeliveredView
    ? active.filter((r) => r.status === "reserved" && Number(r.balance) > 0)
    : [];
  const editable =
    canWrite && !isDeliveredView
      ? active.filter((r) => r.status === "reserved")
      : [];

  // No separate Pay link: payments are recorded from the Edit window.
  const inline: ReactNode[] = [];
  if (canWrite && settleable.length) {
    inline.push(
      <Link
        className={linkClass + " text-emerald-700"}
        href={buildBulkPaymentHref(settleable.map((r) => r.id)) + "&mode=settle"}
        key="settle"
      >
        Settle
      </Link>,
    );
  }
  // One Edit per customer. It opens the order that still needs a price, if
  // any; customers with several orders switch between them inside the window.
  const editTarget =
    editable.find((reservation) => needsReservationPricing(reservation)) ??
    editable[0];
  if (editTarget) {
    inline.push(
      <Link
        className={linkClass + " text-ink"}
        href={editHrefFor(editTarget.id)}
        key="edit"
        scroll={false}
      >
        Edit
      </Link>,
    );
  }
  inline.push(
    <Link
      className={linkClass + " text-gold-dark"}
      href={invoiceHref}
      key="open"
      scroll={false}
      title={"Open invoice, release items, print, and more for " + customerName}
    >
      Open
    </Link>,
  );

  return (
    <div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1 whitespace-nowrap text-sm">
      {inline.map((node, index) => (
        <Fragment key={index}>
          {index > 0 && (
            <span aria-hidden="true" className="text-border">
              |
            </span>
          )}
          {node}
        </Fragment>
      ))}
    </div>
  );
}

/**
 * Rarely used per-reservation actions (back to reserved, archive, restore,
 * delete), shown in the invoice panel's "More" section. Returns null when
 * the user has none.
 */
export function ReservationOrderActions({
  reservations,
  isAdmin,
}: {
  reservations: GroupReservation[];
  isAdmin: boolean;
}) {
  const sections = reservations
    .map((reservation) => {
      const entries: ReactNode[] = [];
      const archived = Boolean(reservation.archived_at);

      if (isAdmin && !archived && reservation.status === "paid") {
        entries.push(
          <Link
            className="text-sm font-semibold text-red-700 hover:underline"
            href={"/reservations/bulk/revert?ids=" + reservation.id}
            key="revert"
          >
            Revert to Reserved
          </Link>,
        );
      }
      // Mark delivered and Cancel are buttons at the top of the invoice
      // panel; only the rarer actions are listed here.
      if (isAdmin) {
        if (archived) {
          entries.push(
            <ConfirmAction
              action={restoreReservation.bind(null, reservation.id)}
              confirmation="Restore this order to the active list?"
              key="restore"
              variant="neutral"
            >
              Restore
            </ConfirmAction>,
            <ConfirmAction
              action={deleteArchivedReservation.bind(null, reservation.id)}
              confirmation="Permanently delete this order? This cannot be undone."
              key="delete"
              variant="danger"
            >
              Delete permanently
            </ConfirmAction>,
          );
        } else {
          entries.push(
            <ConfirmAction
              action={archiveReservation.bind(null, reservation.id)}
              confirmation="Archive this order? Its business status and stock commitment will remain unchanged."
              key="archive"
            >
              Archive
            </ConfirmAction>,
          );
        }
      }

      return { reservation, entries };
    })
    .filter((section) => section.entries.length > 0);

  if (!sections.length) return null;

  return (
    <ul className="space-y-2">
      {sections.map(({ reservation, entries }, index) => (
        <li
          className="flex flex-wrap items-center gap-x-4 gap-y-1"
          key={reservation.id}
        >
          <span className="w-36 text-xs font-bold uppercase tracking-[0.1em] text-muted">
            Order {index + 1}
          </span>
          {entries}
        </li>
      ))}
    </ul>
  );
}
