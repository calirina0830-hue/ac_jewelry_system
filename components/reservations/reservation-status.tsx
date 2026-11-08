export function ReservationStatus({
  status,
  archived,
  delivered,
  appearance = "pill",
}: {
  status: string;
  archived?: boolean;
  delivered?: boolean;
  // "text" renders colored bold text without a badge, for dense tables.
  appearance?: "pill" | "text";
}) {
  const displayStatus = delivered ? "delivered" : status;
  const isText = appearance === "text";

  if (archived) {
    return (
      <span
        className={
          isText
            ? "text-sm font-bold text-stone-600"
            : "inline-flex rounded-full bg-stone-100 px-2.5 py-1 text-xs font-bold text-stone-600"
        }
      >
        Archived · <span className="capitalize">{displayStatus}</span>
      </span>
    );
  }

  const textColor =
    displayStatus === "paid"
      ? "text-emerald-700"
      : displayStatus === "delivered"
        ? "text-sky-700"
        : displayStatus === "cancelled"
          ? "text-red-700"
          : "text-amber-700";
  const background =
    displayStatus === "paid"
      ? "bg-emerald-50"
      : displayStatus === "delivered"
        ? "bg-sky-50"
        : displayStatus === "cancelled"
          ? "bg-red-50"
          : "bg-amber-50";

  return (
    <span
      className={
        (isText
          ? "text-sm font-bold capitalize "
          : "inline-flex rounded-full px-2.5 py-1 text-xs font-bold capitalize " +
            background +
            " ") + textColor
      }
    >
      {displayStatus}
    </span>
  );
}
