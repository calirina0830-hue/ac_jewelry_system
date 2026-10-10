import type { ProfileRole, ReservationStatus } from "@/types/database";

export type ReservationTransitionTarget = ReservationStatus;

export type ReservationTransition = {
  to: ReservationTransitionTarget;
  label: string;
  confirmation: string;
  destructive?: boolean;
};

const TRANSITIONS: Record<ReservationStatus, readonly ReservationStatus[]> = {
  reserved: ["paid", "delivered", "cancelled"],
  paid: ["delivered", "reserved"],
  delivered: [],
  cancelled: [],
};

export function isBusinessTransitionAllowed(
  from: ReservationStatus,
  to: ReservationStatus,
): boolean {
  return TRANSITIONS[from].includes(to);
}

export function canRoleTransitionReservation(
  role: ProfileRole | undefined,
  from: ReservationStatus,
  to: ReservationStatus,
): boolean {
  if (role !== "admin" && role !== "staff") {
    return false;
  }

  if (!isBusinessTransitionAllowed(from, to)) {
    return false;
  }

  if (from === "paid" && to === "reserved") {
    return role === "admin";
  }

  return to !== "cancelled" || role === "admin";
}

export function getReservationTransitions(
  role: ProfileRole | undefined,
  status: ReservationStatus,
): ReservationTransition[] {
  const candidates: ReservationTransition[] =
    status === "reserved"
      ? [
          {
            to: "cancelled",
            label: "Cancel Reservation",
            confirmation:
              "Cancel this reservation? Its virtual stock commitment will be released.",
            destructive: true,
          },
          {
            to: "delivered",
            label: "Mark as Delivered",
            confirmation:
              "Mark this reservation as delivered? Payment status and any remaining balance will not change.",
          },
        ]
      : status === "paid"
        ? [
            {
              to: "delivered",
              label: "Mark as Delivered",
              confirmation:
                "Mark this reservation as delivered? Payment status and any remaining balance will not change.",
            },
          ]
        : [];

  return candidates.filter((transition) =>
    canRoleTransitionReservation(role, status, transition.to),
  );
}
