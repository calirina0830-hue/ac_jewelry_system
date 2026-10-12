import {
  releaseStatusLabel,
  type ReleaseDisplayStatus,
} from "@/lib/reservations/release";

export function ReleaseStatusBadge({
  status,
}: {
  status: ReleaseDisplayStatus | null;
}) {
  const label = releaseStatusLabel(status);
  if (!label) return null;

  return (
    <span className="inline-flex rounded-full bg-violet-50 px-2.5 py-1 text-xs font-bold text-violet-700">
      {label}
    </span>
  );
}