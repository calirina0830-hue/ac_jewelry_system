export function StockStatus({
  archived,
  active,
}: {
  archived: boolean;
  active: boolean;
}) {
  const label = archived ? "Archived" : active ? "Active" : "Inactive";
  const colors = archived
    ? "bg-stone-100 text-stone-600"
    : active
      ? "bg-emerald-50 text-emerald-700"
      : "bg-amber-50 text-amber-700";

  return (
    <span className={"rounded-full px-2.5 py-1 text-xs font-bold " + colors}>
      {label}
    </span>
  );
}
