import { formatDateTime } from "@/lib/format";
import { getActivityActionLabel } from "@/lib/constants/activity";

type SummaryCardsProps = {
  totalAccounts: number;
  activeAccounts: number;
  adminCount: number;
  staffCount: number;
  viewerCount: number;
  activityToday: number;
  lastActivityAt: string | null;
};

function Card({
  label,
  value,
  accent = false,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div
      className={
        "rounded-2xl border p-5 shadow-card " +
        (accent ? "border-gold/40 bg-gold-soft" : "border-border bg-white")
      }
    >
      <p className="text-[0.68rem] font-bold uppercase tracking-[0.16em] text-muted">
        {label}
      </p>
      <p className="mt-2 font-serif text-3xl text-ink">{value}</p>
    </div>
  );
}

export function SummaryCards({
  totalAccounts,
  activeAccounts,
  adminCount,
  staffCount,
  viewerCount,
  activityToday,
  lastActivityAt,
}: SummaryCardsProps) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-6">
      <Card label="Total users" value={String(totalAccounts)} accent />
      <Card label="Active users" value={String(activeAccounts)} />
      <Card label="Admins" value={String(adminCount)} />
      <Card label="Staff" value={String(staffCount)} />
      <Card label="Viewers" value={String(viewerCount)} />
      <Card
        label="Recent activities"
        value={
          lastActivityAt
            ? formatDateTime(lastActivityAt)
            : String(activityToday)
        }
      />
    </div>
  );
}

export function RecentActivity({
  entries,
}: {
  entries: Array<{
    id: string;
    actor_username: string | null;
    actor_display_name: string | null;
    action: string;
    created_at: string;
  }>;
}) {
  return (
    <section className="rounded-2xl border border-border bg-white p-6 shadow-card">
      <h2 className="font-serif text-xl text-ink">Recent activity</h2>
      {entries.length ? (
        <ul className="mt-4 divide-y divide-border/70">
          {entries.map((entry) => (
            <li className="py-3 text-sm" key={entry.id}>
              <span className="font-semibold text-ink">
                {entry.actor_username ?? entry.actor_display_name ?? "Unknown"}
              </span>{" "}
              <span className="text-muted">
                — {formatDateTime(entry.created_at)}
              </span>
              <span className="mt-0.5 block text-muted">
                {getActivityActionLabel(entry.action)}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-4 text-sm text-muted">No activity recorded yet.</p>
      )}
    </section>
  );
}
