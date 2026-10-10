import { ACTIVITY_ACTIONS, ACTIVITY_MODULES } from "@/lib/constants/activity";
import {
  getActivityActionLabel,
  getActivityModuleLabel,
} from "@/lib/constants/activity";

const selectClass =
  "h-11 w-full rounded-xl border border-border bg-white px-3 text-sm outline-none focus:border-gold";

export function ActivityFilters({
  accounts,
  values,
  basePath,
  lockedUserId,
}: {
  accounts: Array<{ id: string; username: string | null; full_name: string }>;
  values: {
    user?: string;
    from?: string;
    to?: string;
    module?: string;
    action?: string;
    q?: string;
  };
  basePath: string;
  lockedUserId?: string;
}) {
  return (
    <form
      action={basePath}
      className="grid gap-3 rounded-2xl border border-border bg-white p-4 shadow-card md:grid-cols-3 xl:grid-cols-6"
      method="get"
    >
      {!lockedUserId && (
        <label className="block text-xs font-bold uppercase tracking-wider text-muted">
          Admin / User
          <select
            className={selectClass + " mt-1.5"}
            defaultValue={values.user ?? ""}
            name="user"
          >
            <option value="">All admins</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.username ?? account.full_name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="block text-xs font-bold uppercase tracking-wider text-muted">
        Date from
        <input
          className={selectClass + " mt-1.5"}
          defaultValue={values.from ?? ""}
          name="from"
          type="date"
        />
      </label>
      <label className="block text-xs font-bold uppercase tracking-wider text-muted">
        Date to
        <input
          className={selectClass + " mt-1.5"}
          defaultValue={values.to ?? ""}
          name="to"
          type="date"
        />
      </label>
      <label className="block text-xs font-bold uppercase tracking-wider text-muted">
        Module
        <select
          className={selectClass + " mt-1.5"}
          defaultValue={values.module ?? ""}
          name="module"
        >
          <option value="">All modules</option>
          {ACTIVITY_MODULES.map((module) => (
            <option key={module} value={module}>
              {getActivityModuleLabel(module)}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-xs font-bold uppercase tracking-wider text-muted">
        Action
        <select
          className={selectClass + " mt-1.5"}
          defaultValue={values.action ?? ""}
          name="action"
        >
          <option value="">All actions</option>
          {ACTIVITY_ACTIONS.map((action) => (
            <option key={action} value={action}>
              {getActivityActionLabel(action)}
            </option>
          ))}
        </select>
      </label>
      <div className="flex items-end gap-2">
        <label className="block flex-1 text-xs font-bold uppercase tracking-wider text-muted">
          Search
          <input
            className={selectClass + " mt-1.5"}
            defaultValue={values.q ?? ""}
            name="q"
            placeholder="Description or reference"
          />
        </label>
        <button
          className="inline-flex h-11 items-center rounded-xl bg-gold px-4 text-sm font-bold text-white transition hover:bg-gold-dark"
          type="submit"
        >
          Apply
        </button>
      </div>
    </form>
  );
}
