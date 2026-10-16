export function ReservationStatus({
  status,
  archived,
  delivered,
}: {
  status: string;
  archived?: boolean;
  delivered?: boolean;
}) {
  const displayStatus = delivered ? "delivered" : status;

  if (archived) {
    return (
      <span className="inline-flex rounded-full bg-stone-100 px-2.5 py-1 text-xs font-bold text-stone-600">
        Archived · <span className="capitalize">{displayStatus}</span>
      </span>
    );
  }

  const colors =
    displayStatus === "paid"
      ? "bg-emerald-50 text-emerald-700"
      : displayStatus === "delivered"
        ? "bg-sky-50 text-sky-700"
        : displayStatus === "cancelled"
          ? "bg-red-50 text-red-700"
          : "bg-amber-50 text-amber-800";

  return (
    <span
      className={
        "inline-flex rounded-full px-2.5 py-1 text-xs font-bold capitalize " +
        colors
      }
    >
      {displayStatus}
    </span>
  );
}
