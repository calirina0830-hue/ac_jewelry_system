import type { Metadata } from "next";
import Link from "next/link";

import { archiveStockItem, restoreStockItem } from "@/actions/stock";
import { StockImage } from "@/components/stock/stock-image";
import { StockStatus } from "@/components/stock/stock-status";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { PageNotice } from "@/components/ui/page-notice";
import { Pagination } from "@/components/ui/pagination";
import { SortLink } from "@/components/ui/sort-link";
import { getCurrentProfile, roleCanWrite, roleIsAdmin } from "@/lib/auth";
import { PAGE_SIZE } from "@/lib/constants/pagination";
import { STOCK_CATEGORIES } from "@/lib/constants/stock";
import { sanitizeSearchTerm, toSearchParams } from "@/lib/query";
import { createClient } from "@/lib/supabase/server";
import { getStockImageUrl } from "@/lib/storage/stock-images";
import { stockQuerySchema } from "@/lib/validation/stock";

export const metadata: Metadata = { title: "Stock" };

type StockPageProps = {
  searchParams: Promise<{
    q?: string;
    category?: string;
    status?: string;
    sort?: string;
    direction?: string;
    page?: string;
    message?: string;
    error?: string;
  }>;
};

export default async function StockPage({ searchParams }: StockPageProps) {
  const rawParams = await searchParams;
  const filters = stockQuerySchema.parse(rawParams);
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
    .from("stock_items")
    .select(
      "id, sku, name, category, image_path, is_active, archived_at",
      { count: "exact" },
    );

  if (filters.status === "active") {
    query = query.is("archived_at", null).eq("is_active", true);
  } else if (filters.status === "inactive") {
    query = query.is("archived_at", null).eq("is_active", false);
  } else if (filters.status === "archived") {
    query = query.not("archived_at", "is", null);
  }

  if (filters.category !== "all") {
    query = query.eq("category", filters.category);
  }

  if (search) {
    const pattern = "%" + search + "%";
    query = query.or("sku.ilike." + pattern + ",name.ilike." + pattern);
  }

  const [
    { data: items, count, error },
    { data: categoryRows },
  ] = await Promise.all([
    query
      .order(filters.sort, { ascending: filters.direction === "asc" })
      .range(from, to),
    supabase.from("stock_items").select("category"),
  ]);
  const categories = Array.from(
    new Set([
      ...STOCK_CATEGORIES,
      ...(categoryRows ?? []).map((row) => row.category),
    ]),
  ).sort((a, b) => a.localeCompare(b));
  const pageCount = Math.max(1, Math.ceil((count ?? 0) / PAGE_SIZE));
  const queryValues = {
    q: search || undefined,
    category: filters.category,
    status: filters.status,
    sort: filters.sort,
    direction: filters.direction,
  };

  return (
    <div className="mx-auto max-w-[1500px] px-5 py-8 sm:px-8 lg:px-10 lg:py-10">
      <PageHeader
        actionHref={canWrite ? "/stock/new" : undefined}
        actionLabel={canWrite ? "Add stock item" : undefined}
        description="Maintain the jewelry catalog used when creating reservations."
        eyebrow="Inventory"
        title="Stock"
      >
        {canWrite && (
          <Link
            className="inline-flex h-11 items-center rounded-xl border border-border bg-white px-5 text-sm font-semibold text-ink hover:border-gold"
            href={"/stock/export?" + toSearchParams(queryValues).toString()}
          >
            Export Stock
          </Link>
        )}
      </PageHeader>
      <PageNotice error={rawParams.error} message={rawParams.message} />

      <form
        className="mt-6 grid gap-3 rounded-2xl border border-border bg-white p-4 shadow-card lg:grid-cols-[minmax(240px,1fr)_170px_160px_auto]"
        method="get"
      >
        <label className="sr-only" htmlFor="stock-search">
          Search stock
        </label>
        <input
          className="h-11 rounded-xl border border-border px-4 text-sm outline-none focus:border-gold focus:ring-4 focus:ring-gold/10"
          defaultValue={search}
          id="stock-search"
          name="q"
          placeholder="Search SKU or item name"
        />
        <label className="sr-only" htmlFor="stock-category">
          Category
        </label>
        <select
          className="h-11 rounded-xl border border-border bg-white px-4 text-sm outline-none focus:border-gold"
          defaultValue={filters.category}
          id="stock-category"
          name="category"
        >
          <option value="all">All categories</option>
          {categories.map((category) => (
            <option key={category} value={category}>
              {category}
            </option>
          ))}
        </select>
        <label className="sr-only" htmlFor="stock-status">
          Status
        </label>
        <select
          className="h-11 rounded-xl border border-border bg-white px-4 text-sm outline-none focus:border-gold"
          defaultValue={filters.status}
          id="stock-status"
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
            href="/stock"
          >
            Clear
          </Link>
        </div>
      </form>

      <section className="mt-6 overflow-hidden rounded-2xl border border-border bg-white shadow-card">
        {error ? (
          <div className="px-6 py-14 text-center text-sm text-red-700" role="alert">
            Stock records could not be loaded. Confirm the Phase 2 migration has
            been applied.
          </div>
        ) : !items?.length ? (
          <EmptyState
            actionHref={canWrite && !search ? "/stock/new" : undefined}
            actionLabel={canWrite && !search ? "Add first item" : undefined}
            description={
              search
                ? "Try adjusting your search, category, or status filters."
                : "Add the first jewelry item to begin building the catalog."
            }
            title={search ? "No matching stock" : "No stock items yet"}
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] border-collapse text-left">
                <thead className="bg-canvas text-[11px] uppercase tracking-[0.14em] text-muted">
                  <tr>
                    <th className="px-5 py-4 font-bold">Image</th>
                    <th className="px-5 py-4 font-bold">
                      <SortLink
                        activeColumn={filters.sort}
                        column="sku"
                        direction={filters.direction}
                        pathname="/stock"
                        query={queryValues}
                      >
                        Item
                      </SortLink>
                    </th>
                    <th className="px-5 py-4 font-bold">Status</th>
                    <th className="px-5 py-4 text-right font-bold">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {items.map((item) => (
                    <tr className="transition hover:bg-canvas/70" key={item.id}>
                      <td className="px-5 py-3">
                        <StockImage
                          alt={item.name}
                          url={getStockImageUrl(item.image_path)}
                        />
                      </td>
                      <td className="px-5 py-4">
                        <Link
                          className="break-words font-semibold text-ink hover:text-gold-dark"
                          href={"/stock/" + item.id}
                        >
                          {item.sku + " - " + item.name + " - " + item.category}
                        </Link>
                      </td>
                      <td className="px-5 py-4">
                        <StockStatus
                          archived={Boolean(item.archived_at)}
                          active={item.is_active}
                        />
                      </td>
                      <td className="px-5 py-4">
                        <div className="flex items-center justify-end gap-3">
                          <Link
                            className="text-sm font-semibold text-gold-dark hover:underline"
                            href={"/stock/" + item.id}
                          >
                            View
                          </Link>
                          {canWrite && (!item.archived_at || isAdmin) && (
                            <Link
                              className="text-sm font-semibold text-ink hover:underline"
                              href={"/stock/" + item.id + "/edit"}
                            >
                              Edit
                            </Link>
                          )}
                          {isAdmin &&
                            (item.archived_at ? (
                              <ConfirmAction
                                action={restoreStockItem.bind(null, item.id)}
                                confirmation={"Restore " + item.name + "?"}
                                variant="neutral"
                              >
                                Restore
                              </ConfirmAction>
                            ) : (
                              <ConfirmAction
                                action={archiveStockItem.bind(null, item.id)}
                                confirmation={
                                  "Archive " +
                                  item.name +
                                  "? The item can be restored later."
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
              pathname="/stock"
              query={queryValues}
            />
          </>
        )}
      </section>
    </div>
  );
}
