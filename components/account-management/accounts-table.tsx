import Link from "next/link";

import {
  sendPasswordReset,
  setAccountRole,
  setAccountStatus,
} from "@/actions/account-management";
import { formatDateTime } from "@/lib/format";
import type { ProfileRole } from "@/types/database";

export type AccountRow = {
  id: string;
  username: string | null;
  full_name: string;
  email: string | null;
  role: ProfileRole;
  is_active: boolean;
  created_at: string;
  last_login_at: string | null;
  last_activity_at: string | null;
};

const ROLE_BADGES: Record<ProfileRole, string> = {
  developer: "border-violet-200 bg-violet-50 text-violet-800",
  owner: "border-gold bg-gold-soft text-gold-dark",
  admin: "border-ink/15 bg-ink/5 text-ink",
  staff: "border-sky-200 bg-sky-50 text-sky-800",
  viewer: "border-border bg-canvas text-muted",
};

function Badge({ className, children }: { className: string; children: string }) {
  return (
    <span
      className={
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-[0.7rem] font-bold uppercase tracking-wide " +
        className
      }
    >
      {children}
    </span>
  );
}

const inputClass =
  "h-10 rounded-xl border border-border bg-white px-3 text-sm outline-none focus:border-gold focus:ring-2 focus:ring-gold/10";
const buttonClass =
  "inline-flex h-10 items-center justify-center rounded-xl px-4 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50";

export function AccountsTable({
  accounts,
  currentUserId,
}: {
  accounts: AccountRow[];
  currentUserId: string;
}) {
  if (!accounts.length) {
    return (
      <p className="rounded-2xl border border-border bg-white p-8 text-center text-sm text-muted shadow-card">
        No accounts exist yet.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-2xl border border-border bg-white shadow-card">
      <table className="w-full min-w-[1080px] text-left text-sm">
        <thead>
          <tr className="border-b border-border bg-canvas/70 text-[0.68rem] uppercase tracking-wider text-muted">
            <th className="px-4 py-3 font-bold">Username</th>
            <th className="px-4 py-3 font-bold">Name</th>
            <th className="px-4 py-3 font-bold">Email</th>
            <th className="px-4 py-3 font-bold">Role</th>
            <th className="px-4 py-3 font-bold">Status</th>
            <th className="px-4 py-3 font-bold">Created</th>
            <th className="px-4 py-3 font-bold">Last login</th>
            <th className="px-4 py-3 font-bold">Last activity</th>
            <th className="px-4 py-3 font-bold">Actions</th>
          </tr>
        </thead>
        <tbody>
          {accounts.map((account) => {
            const isSelf = account.id === currentUserId;

            return (
              <tr
                className="border-b border-border/70 align-top last:border-b-0"
                key={account.id}
              >
                <td className="px-4 py-4 font-semibold text-ink">
                  {account.username ?? "—"}
                  {isSelf && (
                    <span className="mt-1 block text-[0.65rem] font-bold uppercase tracking-wide text-gold-dark">
                      You
                    </span>
                  )}
                </td>
                <td className="px-4 py-4 text-ink">{account.full_name}</td>
                <td className="px-4 py-4 text-muted">{account.email ?? "—"}</td>
                <td className="px-4 py-4">
                  <Badge className={ROLE_BADGES[account.role]}>
                    {account.role}
                  </Badge>
                </td>
                <td className="px-4 py-4">
                  <Badge
                    className={
                      account.is_active
                        ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                        : "border-red-200 bg-red-50 text-red-700"
                    }
                  >
                    {account.is_active ? "Active" : "Disabled"}
                  </Badge>
                </td>
                <td className="px-4 py-4 text-muted">
                  {formatDateTime(account.created_at)}
                </td>
                <td className="px-4 py-4 text-muted">
                  {account.last_login_at
                    ? formatDateTime(account.last_login_at)
                    : "Never"}
                </td>
                <td className="px-4 py-4 text-muted">
                  {account.last_activity_at
                    ? formatDateTime(account.last_activity_at)
                    : "No recorded activity"}
                </td>
                <td className="px-4 py-4">
                  <div className="flex flex-col gap-2">
                    <Link
                      className={
                        buttonClass +
                        " border border-border bg-white text-ink hover:border-gold"
                      }
                      href={"/account-management/" + account.id + "/activity"}
                    >
                      View activity
                    </Link>

                    {!isSelf && (
                      <>
                        <form action={setAccountStatus}>
                          <input
                            name="userId"
                            type="hidden"
                            value={account.id}
                          />
                          <input
                            name="isActive"
                            type="hidden"
                            value={account.is_active ? "false" : "true"}
                          />
                          <button
                            className={
                              buttonClass +
                              " w-full border " +
                              (account.is_active
                                ? "border-red-200 bg-red-50 text-red-700 hover:border-red-300"
                                : "border-emerald-200 bg-emerald-50 text-emerald-700 hover:border-emerald-300")
                            }
                            type="submit"
                          >
                            {account.is_active ? "Disable" : "Activate"}
                          </button>
                        </form>

                        <form action={sendPasswordReset}>
                          <input
                            name="userId"
                            type="hidden"
                            value={account.id}
                          />
                          <button
                            className={
                              buttonClass +
                              " w-full border border-border bg-white text-ink hover:border-gold"
                            }
                            type="submit"
                          >
                            Send reset link
                          </button>
                        </form>

                        <form action={setAccountRole} className="flex gap-2">
                          <input
                            name="userId"
                            type="hidden"
                            value={account.id}
                          />
                          <select
                            aria-label={"Role for " + (account.username ?? account.full_name)}
                            className={inputClass}
                            defaultValue={account.role}
                            name="newRole"
                          >
                            <option value="admin">admin</option>
                            <option value="staff">staff</option>
                            <option value="viewer">viewer</option>
                          </select>
                          <button
                            className={buttonClass + " bg-gold text-white hover:bg-gold-dark"}
                            type="submit"
                          >
                            Set
                          </button>
                        </form>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
