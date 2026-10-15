import type { Metadata } from "next";
import Link from "next/link";

import {
  archiveCustomer,
  restoreCustomer,
} from "@/actions/customers";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { PageNotice } from "@/components/ui/page-notice";
import { Pagination } from "@/components/ui/pagination";
import { SortLink } from "@/components/ui/sort-link";
import { getCurrentProfile, roleCanWrite, roleIsAdmin } from "@/lib/auth";
import { formatDate } from "@/lib/format";
import { PAGE_SIZE } from "@/lib/constants/pagination";
import { sanitizeSearchTerm } from "@/lib/query";
import { createClient } from "@/lib/supabase/server";
import { customerQuerySchema } from "@/lib/validation/customers";

export const metadata: Metadata = { title: "Customers" };

type CustomersPageProps = {
  searchParams: Promise<{
    q?: string;
    status?: string;
    sort?: string;
    direction?: string;
    page?: string;
    message?: string;
    error?: string;
  }>;
};

export default async function CustomersPage({
  searchParams,
}: CustomersPageProps) {
  const rawParams = await searchParams;
  const filters = customerQuerySchema.parse(rawParams);
  const search = sanitizeSearchTerm(filters.q);
  const [profile, supabase] = await Promise.all([
    getCurrentProfile(),
    createClient(),
  ]);
  const canWrite = roleCanWrite(profile?.role);
  const isAdmin = roleIsAdmin(profile?.role);
  const from = (filters.page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  let query = supabase
    .from("customers")
    .select(
      "id, name, facebook_name, phone, address, created_at, archived_at",
      { count: "exact" },
    );

  if (filters.status === "active") {
    query = query.is("archived_at", null);
  } else if (filters.status === "archived") {
    query = query.not("archived_at", "is", null);
  }

  if (search) {
    const pattern = "%" + search + "%";
    query = query.or(
      "name.ilike." +
        pattern +
        ",facebook_name.ilike." +
        pattern +
        ",phone.ilike." +
        pattern,
    );
  }

  const {
    data: customers,
    count,
    error,
  } = await query
    .order(filters.sort, { ascending: filters.direction === "asc" })
    .range(from, to);
  const pageCount = Math.max(1, Math.ceil((count ?? 0) / PAGE_SIZE));
  const queryValues = {
    q: search || undefined,
    status: filters.status,
    sort: filters.sort,
    direction: filters.direction,
  };

  return (
    <div className="mx-auto max-w-[1500px] px-5 py-8 sm:px-8 lg:px-10 lg:py-10">
      <PageHeader
        actionHref={canWrite ? "/customers/new" : undefined}
        actionLabel={canWrite ? "Add customer" : undefined}
        description="Manage client contact details and service notes in one secure place."
        eyebrow="Directory"
        title="Customers"
      />
      <PageNotice error={rawParams.error} message={rawParams.message} />

      <form
        className="mt-6 grid gap-3 rounded-2xl border border-border bg-white p-4 shadow-card md:grid-cols-[minmax(240px,1fr)_180px_auto]"
        method="get"
      >
        <label className="sr-only" htmlFor="customer-search">
          Search customers
        </label>
        <input
          className="h-11 rounded-xl border border-border px-4 text-sm outline-none focus:border-gold focus:ring-4 focus:ring-gold/10"
          defaultValue={search}
          id="customer-search"
          name="q"
          placeholder="Search name, Facebook / CS, or phone"
        />
        <label className="sr-only" htmlFor="customer-status">
          Customer status
        </label>
        <select
          className="h-11 rounded-xl border border-border bg-white px-4 text-sm outline-none focus:border-gold"
          defaultValue={filters.status}
          id="customer-status"
          name="status"
        >
          <option value="active">Active</option>
          <option value="archived">Archived</option>
          <option value="all">All records</option>
        </select>
        <div className="flex gap-2">
          <button
            className="h-11 rounded-xl bg-ink px-5 text-sm font-bold text-white"
            type="submit"
          >
            Apply
          </button>
          <Link
            className="inline-flex h-11 items-center rounded-xl border border-border px-4 text-sm font-semibold text-muted"
            href="/customers"
          >
            Clear
          </Link>
        </div>
      </form>

      <section className="mt-6 overflow-hidden rounded-2xl border border-border bg-white shadow-card">
        {error ? (
          <div className="px-6 py-14 text-center text-sm text-red-700" role="alert">
            Customer records could not be loaded. Confirm the Phase 2 migration
            has been applied.
          </div>
        ) : !customers?.length ? (
          <EmptyState
            actionHref={canWrite && !search ? "/customers/new" : undefined}
            actionLabel={canWrite && !search ? "Add first customer" : undefined}
            description={
              search
                ? "Try adjusting your search or status filter."
                : "Add your first customer to begin building the client directory."
            }
            title={search ? "No matching customers" : "No customers yet"}
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1080px] border-collapse text-left">
                <thead className="bg-canvas text-[11px] uppercase tracking-[0.14em] text-muted">
                  <tr>
                    <th className="px-5 py-4 font-bold">
                      <SortLink
                        activeColumn={filters.sort}
                        column="name"
                        direction={filters.direction}
                        pathname="/customers"
                        query={queryValues}
                      >
                        Name
                      </SortLink>
                    </th>
                    <th className="px-5 py-4 font-bold">
                      <SortLink
                        activeColumn={filters.sort}
                        column="facebook_name"
                        direction={filters.direction}
                        pathname="/customers"
                        query={queryValues}
                      >
                        Facebook / CS
                      </SortLink>
                    </th>
                    <th className="px-5 py-4 font-bold">Phone</th>
                    <th className="px-5 py-4 font-bold">Address</th>
                    <th className="px-5 py-4 font-bold">
                      <SortLink
                        activeColumn={filters.sort}
                        column="created_at"
                        direction={filters.direction}
                        pathname="/customers"
                        query={queryValues}
                      >
                        Date added
                      </SortLink>
                    </th>
                    <th className="px-5 py-4 font-bold">Status</th>
                    <th className="px-5 py-4 text-right font-bold">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {customers.map((customer) => (
                    <tr className="transition hover:bg-canvas/70" key={customer.id}>
                      <td className="px-5 py-4">
                        <Link
                          className="font-semibold text-ink hover:text-gold-dark"
                          href={"/customers/" + customer.id}
                        >
                          {customer.name}
                        </Link>
                      </td>
                      <td className="px-5 py-4 text-sm font-semibold text-muted">
                        {customer.facebook_name ?? "—"}
                      </td>
                      <td className="px-5 py-4 text-sm text-muted">
                        {customer.phone ?? "—"}
                      </td>
                      <td className="max-w-64 truncate px-5 py-4 text-sm text-muted">
                        {customer.address ?? "—"}
                      </td>
                      <td className="whitespace-nowrap px-5 py-4 text-sm text-muted">
                        {formatDate(customer.created_at)}
                      </td>
                      <td className="px-5 py-4">
                        <span
                          className={
                            "rounded-full px-2.5 py-1 text-xs font-bold " +
                            (customer.archived_at
                              ? "bg-stone-100 text-stone-600"
                              : "bg-emerald-50 text-emerald-700")
                          }
                        >
                          {customer.archived_at ? "Archived" : "Active"}
                        </span>
                      </td>
                      <td className="px-5 py-4">
                        <div className="flex items-center justify-end gap-3">
                          <Link
                            className="text-sm font-semibold text-gold-dark hover:underline"
                            href={"/customers/" + customer.id}
                          >
                            View
                          </Link>
                          {canWrite &&
                            (!customer.archived_at || isAdmin) && (
                              <Link
                                className="text-sm font-semibold text-ink hover:underline"
                                href={"/customers/" + customer.id + "/edit"}
                              >
                                Edit
                              </Link>
                            )}
                          {isAdmin &&
                            (customer.archived_at ? (
                              <ConfirmAction
                                action={restoreCustomer.bind(null, customer.id)}
                                confirmation={"Restore " + customer.name + "?"}
                                variant="neutral"
                              >
                                Restore
                              </ConfirmAction>
                            ) : (
                              <ConfirmAction
                                action={archiveCustomer.bind(null, customer.id)}
                                confirmation={
                                  "Archive " +
                                  customer.name +
                                  "? The record can be restored later."
                                }
                              >
                                Archive
                              </ConfirmAction>
                            ))}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination
              page={filters.page}
              pageCount={pageCount}
              pathname="/customers"
              query={queryValues}
            />
          </>
        )}
      </section>
    </div>
  );
}
