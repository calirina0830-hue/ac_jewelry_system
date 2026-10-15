"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { RESERVATION_STATUS_OPTIONS } from "@/lib/constants/reservations";
import { toSearchParams } from "@/lib/query";

type FilterValues = {
  q?: string;
  liveBatch?: string;
  fromDate?: string;
  toDate?: string;
  status: string;
  archive: string;
  pageSize?: string;
  sort?: string;
  direction?: string;
};

export function ReservationFilters({
  initialFilters,
}: {
  initialFilters: FilterValues;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  // Search input state with local tracking for instant keystrokes
  const [searchTerm, setSearchTerm] = useState(initialFilters.q ?? "");
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Sync state if URL changes externally
  useEffect(() => {
    const currentQ = searchParams.get("q") ?? "";
    setSearchTerm(currentQ);
  }, [searchParams]);

  const updateFilters = useCallback(
    (overrides: Partial<FilterValues>) => {
      const currentParams = new URLSearchParams(searchParams.toString());

      // If search or status or dates change, reset page to 1
      currentParams.delete("page");

      // Extract current values
      const newStatus = overrides.status !== undefined ? overrides.status : (searchParams.get("status") ?? initialFilters.status);
      const newArchive = overrides.archive !== undefined ? overrides.archive : (searchParams.get("archive") ?? initialFilters.archive);
      const newQ = overrides.q !== undefined ? overrides.q : (searchParams.get("q") ?? "");
      const newFrom = overrides.fromDate !== undefined ? overrides.fromDate : (searchParams.get("fromDate") ?? "");
      const newTo = overrides.toDate !== undefined ? overrides.toDate : (searchParams.get("toDate") ?? "");
      const newPageSize = overrides.pageSize !== undefined ? overrides.pageSize : (searchParams.get("pageSize") ?? initialFilters.pageSize);

      const params = toSearchParams({
        q: newQ ? newQ.trim() : undefined,
        status: newStatus,
        archive: newArchive,
        fromDate: newFrom || undefined,
        toDate: newTo || undefined,
        pageSize: newPageSize !== "10" ? newPageSize : undefined,
        sort: searchParams.get("sort") ?? undefined,
        direction: searchParams.get("direction") ?? undefined,
        liveBatch: searchParams.get("liveBatch") ?? undefined,
      });

      startTransition(() => {
        router.replace(`${pathname}?${params.toString()}`);
      });
    },
    [router, pathname, searchParams, initialFilters],
  );

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setSearchTerm(val);

    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }

    debounceTimerRef.current = setTimeout(() => {
      updateFilters({ q: val });
    }, 150);
  };

  const handleStatusChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    updateFilters({ status: e.target.value });
  };

  const handleFromDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    updateFilters({ fromDate: e.target.value });
  };

  const handleToDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    updateFilters({ toDate: e.target.value });
  };

  const handleArchiveChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    updateFilters({ archive: e.target.value });
  };

  const handlePageSizeChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    updateFilters({ pageSize: e.target.value });
  };

  const currentStatus = searchParams.get("status") ?? initialFilters.status;
  const currentArchive = searchParams.get("archive") ?? initialFilters.archive;
  const currentFrom = searchParams.get("fromDate") ?? initialFilters.fromDate ?? "";
  const currentTo = searchParams.get("toDate") ?? initialFilters.toDate ?? "";
  const currentPageSize = searchParams.get("pageSize") ?? initialFilters.pageSize ?? "10";

  return (
    <form
      className="mt-6 grid items-end gap-3 rounded-2xl border border-border bg-white p-4 shadow-card sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-[minmax(240px,1fr)_135px_135px_145px_155px_130px_auto_auto]"
      method="get"
      onSubmit={(e) => {
        e.preventDefault();
        if (debounceTimerRef.current) {
          clearTimeout(debounceTimerRef.current);
        }
        updateFilters({ q: searchTerm });
      }}
    >
      <label className="block" htmlFor="reservation-search">
        <span className="mb-1.5 flex items-center justify-between text-xs font-bold uppercase leading-4 tracking-[0.1em] text-muted">
          <span>Search</span>
          {isPending && <span className="text-[10px] lowercase text-gold font-normal">searching...</span>}
        </span>
        <input
          className="h-11 w-full rounded-xl border border-border px-4 text-sm outline-none focus:border-gold focus:ring-4 focus:ring-gold/10"
          id="reservation-search"
          name="q"
          onChange={handleSearchChange}
          placeholder="Reservation no., customer, FB / CS name, SKU, or item name"
          value={searchTerm}
        />
      </label>
      <label className="block" htmlFor="reservation-from-date">
        <span className="mb-1.5 block text-xs font-bold uppercase leading-4 tracking-[0.1em] text-muted">
          From Date
        </span>
        <input
          className="block h-11 w-full rounded-xl border border-border px-3 text-sm font-normal text-ink outline-none focus:border-gold focus:ring-4 focus:ring-gold/10"
          id="reservation-from-date"
          name="fromDate"
          onChange={handleFromDateChange}
          type="date"
          value={currentFrom}
        />
      </label>
      <label className="block" htmlFor="reservation-to-date">
        <span className="mb-1.5 block text-xs font-bold uppercase leading-4 tracking-[0.1em] text-muted">
          To Date
        </span>
        <input
          className="block h-11 w-full rounded-xl border border-border px-3 text-sm font-normal text-ink outline-none focus:border-gold focus:ring-4 focus:ring-gold/10"
          id="reservation-to-date"
          name="toDate"
          onChange={handleToDateChange}
          type="date"
          value={currentTo}
        />
      </label>
      <label className="block" htmlFor="reservation-status">
        <span className="mb-1.5 block text-xs font-bold uppercase leading-4 tracking-[0.1em] text-muted">
          Status
        </span>
        <select
          className="h-11 w-full rounded-xl border border-border bg-white px-4 text-sm outline-none focus:border-gold focus:ring-4 focus:ring-gold/10"
          id="reservation-status"
          name="status"
          onChange={handleStatusChange}
          value={currentStatus}
        >
          <option value="all">All statuses</option>
          {RESERVATION_STATUS_OPTIONS.map((status) => (
            <option key={status.value} value={status.value}>
              {status.label}
            </option>
          ))}
        </select>
      </label>
      <label className="block" htmlFor="reservation-archive">
        <span className="mb-1.5 block text-xs font-bold uppercase leading-4 tracking-[0.1em] text-muted">
          Records
        </span>
        <select
          className="h-11 w-full rounded-xl border border-border bg-white px-4 text-sm outline-none focus:border-gold focus:ring-4 focus:ring-gold/10"
          id="reservation-archive"
          name="archive"
          onChange={handleArchiveChange}
          value={currentArchive}
        >
          <option value="active">Active reservations</option>
          <option value="archived">Archived reservations</option>
          <option value="all">All records</option>
        </select>
      </label>
      <label className="block" htmlFor="reservation-page-size">
        <span className="mb-1.5 block text-xs font-bold uppercase leading-4 tracking-[0.1em] text-muted">
          Page Size
        </span>
        <select
          className="h-11 w-full rounded-xl border border-border bg-white px-3 text-sm outline-none focus:border-gold focus:ring-4 focus:ring-gold/10"
          id="reservation-page-size"
          name="pageSize"
          onChange={handlePageSizeChange}
          value={currentPageSize}
        >
          <option value="10">10 per page</option>
          <option value="20">20 per page</option>
          <option value="50">50 per page</option>
          <option value="all">See All</option>
        </select>
      </label>
      <button
        className="h-11 rounded-xl bg-ink px-5 text-sm font-bold text-white transition hover:bg-ink/90 disabled:opacity-50"
        disabled={isPending}
        type="submit"
      >
        {isPending ? "Filtering..." : "Apply"}
      </button>
      <Link
        className="inline-flex h-11 items-center justify-center rounded-xl border border-border px-4 text-sm font-semibold text-muted transition hover:border-gold hover:text-ink"
        href={
          "/reservations?" +
          toSearchParams({
            status: currentStatus,
            archive: currentArchive,
          }).toString()
        }
        onClick={() => setSearchTerm("")}
      >
        Clear
      </Link>
    </form>
  );
}
