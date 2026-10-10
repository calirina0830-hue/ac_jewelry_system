export function ReservationStatus({
  status,
  archived,
  delivered,
}: {
  status: string;
  archived?: boolean;
  delivered?: boolean;
}) {
  if (archived) {
    return (
      <span className="inline-flex flex-wrap gap-1">
        <span className="rounded-full bg-stone-100 px-2.5 py-1 text-xs font-bold text-stone-600">
          Archived · <span className="capitalize">{status}</span>
        </span>
        {delivered && (
          <span className="rounded-full bg-sky-50 px-2.5 py-1 text-xs font-bold text-sky-700">
            Delivered
          </span>
        )}
      </span>
    );
  }

  const colors =
    status === "paid"
      ? "bg-emerald-50 text-emerald-700"
      : status === "delivered"
        ? "bg-sky-50 text-sky-700"
        : status === "cancelled"
          ? "bg-red-50 text-red-700"
          : "bg-amber-50 text-amber-800";

  return (
    <span className="inline-flex flex-wrap gap-1">
      <span className={"rounded-full px-2.5 py-1 text-xs font-bold capitalize " + colors}>
        {status}
      </span>
      {delivered && (
        <span className="rounded-full bg-sky-50 px-2.5 py-1 text-xs font-bold text-sky-700">
          Delivered
        </span>
      )}
    </span>
  );
}
