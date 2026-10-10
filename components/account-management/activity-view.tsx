import { redirect } from "next/navigation";

import { authorizeOwner } from "@/lib/auth";
import { formatDateTime } from "@/lib/format";
import {
  getActivityActionLabel,
  getActivityModuleLabel,
} from "@/lib/constants/activity";
import { sanitizeSearchTerm } from "@/lib/query";
import { createClient } from "@/lib/supabase/server";
import {
  parseDateOnlyToExclusiveEndIso,
  parseDateOnlyToUtcIso,
} from "@/lib/dates";
import { activityQuerySchema } from "@/lib/validation/accounts";

import { ActivityFilters } from "@/components/account-management/activity-filters";
import { EmptyState } from "@/components/ui/empty-state";
import { Pagination } from "@/components/ui/pagination";

const ACTIVITY_PAGE_SIZE = 25;

type RawActivityFilters = {
  user?: string;
  from?: string;
  to?: string;
  module?: string;
  action?: string;
  q?: string;
  page?: string;
};

// Shared owner-only activity explorer. With lockedUserId it shows one admin's
// trail; otherwise the Admin/User filter decides.
export async function ActivityView({
  searchParams,
  lockedUserId,
}: {
  searchParams: Promise<RawActivityFilters>;
  lockedUserId?: string;
}) {
  const authorization = await authorizeOwner();

  if (!authorization) {
    redirect("/dashboard?error=not-authorized");
  }

  const rawParams = await searchParams;
  const filters = activityQuerySchema.parse(rawParams);
  const actorId = lockedUserId ?? filters.user;

  const supabase = await createClient();
  const [{ data: accounts }] = await Promise.all([
    supabase.rpc("list_account_management_profiles"),
  ]);

  const fromIso = filters.from
    ? parseDateOnlyToUtcIso(filters.from)
    : null;
  const toIso = filters.to
    ? parseDateOnlyToExclusiveEndIso(filters.to)
    : null;

  let query = supabase
    .from("admin_activity_logs")
    .select("*", { count: "exact" });

  if (actorId) {
    query = query.eq("actor_user_id", actorId);
  }
  if (fromIso) {
    query = query.gte("created_at", fromIso);
  }
  if (toIso) {
    query = query.lt("created_at", toIso);
  }
  if (filters.module) {
    query = query.eq("entity_type", filters.module);
  }
  if (filters.action) {
    query = query.eq("action", filters.action);
  }

  const search = sanitizeSearchTerm(filters.q ?? "");
  if (search) {
    const pattern = "%" + search + "%";
    query = query.or(
      "description.ilike." +
        pattern +
        ",entity_id.ilike." +
        pattern +
        ",actor_username.ilike." +
        pattern,
    );
  }

  const from = ((filters.page ?? 1) - 1) * ACTIVITY_PAGE_SIZE;
  const { data: entries, count } = await query
    .order("created_at", { ascending: false })
    .range(from, from + ACTIVITY_PAGE_SIZE - 1);

  const pageCount = Math.max(
    1,
    Math.ceil((count ?? 0) / ACTIVITY_PAGE_SIZE),
  );
  const accountRows = accounts ?? [];
  const activeAccount = lockedUserId
    ? accountRows.find((account) => account.id === lockedUserId)
    : undefined;

  const filterValues = {
    user: filters.user,
    from: filters.from,
    to: filters.to,
    module: filters.module,
    action: filters.action,
    q: filters.q,
  };
  const basePath = lockedUserId
    ? "/account-management/" + lockedUserId + "/activity"
    : "/account-management/activity";
  const paginationQuery = Object.fromEntries(
    Object.entries(filterValues).filter(([, value]) => Boolean(value)),
  ) as Record<string, string | undefined>;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-6">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.22em] text-gold-dark">
            Audit Trail
          </p>
          <h1 className="mt-2 font-serif text-3xl text-ink">
            {activeAccount
              ? "Activity — " + (activeAccount.username ?? activeAccount.full_name)
              : "Admin activity"}
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">
            Newest first. Entries are append-only and cannot be edited or
            deleted by anyone.
          </p>
        </div>
      </header>

      <ActivityFilters
        accounts={accountRows}
        basePath={basePath}
        lockedUserId={lockedUserId}
        values={filterValues}
      />

      {entries?.length ? (
        <>
          <div className="overflow-x-auto rounded-2xl border border-border bg-white shadow-card">
            <table className="w-full min-w-[860px] text-left text-sm">
              <thead>
                <tr className="border-b border-border bg-canvas/70 text-[0.68rem] uppercase tracking-wider text-muted">
                  <th className="px-4 py-3 font-bold">Date / Time</th>
                  <th className="px-4 py-3 font-bold">Admin</th>
                  <th className="px-4 py-3 font-bold">Action</th>
                  <th className="px-4 py-3 font-bold">Module</th>
                  <th className="px-4 py-3 font-bold">Reference</th>
                  <th className="px-4 py-3 font-bold">Description</th>
                </tr>
              </thead>
              <tbody>
                {(entries ?? []).map((entry) => (
                  <tr
                    className="border-b border-border/70 last:border-b-0"
                    key={entry.id}
                  >
                    <td className="whitespace-nowrap px-4 py-3 text-muted">
                      {formatDateTime(entry.created_at)}
                    </td>
                    <td className="px-4 py-3 font-semibold text-ink">
                      {entry.actor_username ??
                        entry.actor_display_name ??
                        "Unknown"}
                    </td>
                    <td className="px-4 py-3 text-ink">
                      {getActivityActionLabel(entry.action)}
                    </td>
                    <td className="px-4 py-3 text-muted">
                      {entry.entity_type
                        ? getActivityModuleLabel(entry.entity_type)
                        : "—"}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-muted">
                      {entry.entity_id
                        ? entry.entity_id.slice(0, 13) + "…"
                        : "—"}
                    </td>
                    <td className="px-4 py-3 text-muted">
                      {entry.description ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            pageCount={pageCount}
            page={filters.page ?? 1}
            pathname={basePath}
            query={paginationQuery}
          />
        </>
      ) : (
        <div className="rounded-2xl border border-border bg-white shadow-card">
          <EmptyState
            description="No recorded activity matches these filters."
            title="No activity found"
          />
        </div>
      )}
    </div>
  );
}
