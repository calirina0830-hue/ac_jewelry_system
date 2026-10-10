import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { authorizeOwner } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { startOfUtcDay } from "@/lib/dates";

import { AccountsTable } from "@/components/account-management/accounts-table";
import { InviteForm } from "@/components/account-management/invite-form";
import { OwnerNotice } from "@/components/account-management/owner-notice";
import {
  RecentActivity,
  SummaryCards,
} from "@/components/account-management/summary-cards";

export const metadata: Metadata = {
  title: "Account Management",
  robots: { index: false, follow: false },
};

type AccountManagementPageProps = {
  searchParams: Promise<{ message?: string; error?: string }>;
};

export default async function AccountManagementPage({
  searchParams,
}: AccountManagementPageProps) {
  const params = await searchParams;
  const authorization = await authorizeOwner();

  if (!authorization) {
    redirect("/dashboard?error=not-authorized");
  }

  const supabase = await createClient();
  const dayStartIso = startOfUtcDay().toISOString();

  const [{ data: accounts }, todayCount, latestActivity, recentActivity] =
    await Promise.all([
      supabase.rpc("list_account_management_profiles"),
      supabase
        .from("admin_activity_logs")
        .select("id", { count: "exact", head: true })
        .gte("created_at", dayStartIso),
      supabase
        .from("admin_activity_logs")
        .select("created_at")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from("admin_activity_logs")
        .select(
          "id, actor_username, actor_display_name, action, created_at",
        )
        .order("created_at", { ascending: false })
        .limit(8),
    ]);

  const accountRows = accounts ?? [];
  const activeAccounts = accountRows.filter((account) => account.is_active);
  const countRole = (role: string) =>
    accountRows.filter((account) => account.role === role).length;

  return (
    <div className="space-y-8">
      <header>
        <p className="text-xs font-bold uppercase tracking-[0.22em] text-gold-dark">
          System Area
        </p>
        <h1 className="mt-2 font-serif text-4xl text-ink">Account Management</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">
          Developer and owner oversight of every account and its recorded
          activity. Audit history is append-only and can never be deleted.
        </p>
      </header>

      <OwnerNotice error={params.error} message={params.message} />

      <SummaryCards
        activeAccounts={activeAccounts.length}
        adminCount={countRole("admin")}
        activityToday={todayCount.count ?? 0}
        lastActivityAt={latestActivity?.data?.created_at ?? null}
        staffCount={countRole("staff")}
        totalAccounts={accountRows.length}
        viewerCount={countRole("viewer")}
      />

      <section>
        <h2 className="mb-4 font-serif text-xl text-ink">All accounts</h2>
        <AccountsTable
          accounts={accountRows}
          currentUserId={authorization.user.id}
        />
      </section>

      <InviteForm />

      <RecentActivity entries={recentActivity.data ?? []} />
    </div>
  );
}
