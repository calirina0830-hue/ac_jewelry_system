"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import {
  applyReservationSearch,
  clearReservationSearch,
  submitReservationSearch,
} from "@/actions/private-search";
import { toSearchParams } from "@/lib/query";

// "YYYY-MM-DDTHH:mm" -> { date, time }; a plain date has no time.
function splitDateTime(value: string): { date: string; time: string } {
  return value.length > 10
    ? { date: value.slice(0, 10), time: value.slice(11, 16) }
    : { date: value, time: "" };
}

type FilterValues = {
  q?: string;
  liveBatch?: string;
  fromDate?: string;
  toDate?: string;
  status: string;
  archive: string;
  payment?: string;
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

  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  const updateFilters = useCallback(
    (overrides: Partial<FilterValues>) => {
      const currentParams = new URLSearchParams(searchParams.toString());

      // If search or status or dates change, reset page to 1
      currentParams.delete("page");

      // Extract current values
      const newStatus = overrides.status !== undefined ? overrides.status : (searchParams.get("status") ?? initialFilters.status);
      const newArchive = overrides.archive !== undefined ? overrides.archive : (searchParams.get("archive") ?? initialFilters.archive);
      const newFrom = overrides.fromDate !== undefined ? overrides.fromDate : (searchParams.get("fromDate") ?? "");
      const newTo = overrides.toDate !== undefined ? overrides.toDate : (searchParams.get("toDate") ?? "");
      const newPageSize = overrides.pageSize !== undefined ? overrides.pageSize : (searchParams.get("pageSize") ?? initialFilters.pageSize);
      const newPayment = searchParams.get("payment") ?? initialFilters.payment ?? "all";

      const params = toSearchParams({
        status: newStatus,
        archive: newArchive,
        payment: newPayment !== "all" ? newPayment : undefined,
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
      startTransition(() => {
        void applyReservationSearch(val, {
          liveBatch: initialFilters.liveBatch,
          fromDate: searchParams.get("fromDate") ?? initialFilters.fromDate,
          toDate: searchParams.get("toDate") ?? initialFilters.toDate,
          status: searchParams.get("status") ?? initialFilters.status,
          archive: searchParams.get("archive") ?? initialFilters.archive,
          payment: searchParams.get("payment") ?? initialFilters.payment,
          pageSize:
            searchParams.get("pageSize") ?? initialFilters.pageSize,
          sort: searchParams.get("sort") ?? initialFilters.sort,
          direction:
            searchParams.get("direction") ?? initialFilters.direction,
        });
      });
    }, 150);
  };

  // A From/To value is "YYYY-MM-DD", or "YYYY-MM-DDTHH:mm" once a time is set.
  // The date and the optional time are separate inputs; they are joined here.
  const handleFromDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const time = splitDateTime(searchParams.get("fromDate") ?? initialFilters.fromDate ?? "").time;
    updateFilters({ fromDate: e.target.value ? e.target.value + (time ? "T" + time : "") : "" });
  };

  const handleFromTimeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { date } = splitDateTime(searchParams.get("fromDate") ?? initialFilters.fromDate ?? "");
    if (!date) return;
    updateFilters({ fromDate: date + (e.target.value ? "T" + e.target.value : "") });
  };

  const handleToDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const time = splitDateTime(searchParams.get("toDate") ?? initialFilters.toDate ?? "").time;
    updateFilters({ toDate: e.target.value ? e.target.value + (time ? "T" + time : "") : "" });
  };

  const handleToTimeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { date } = splitDateTime(searchParams.get("toDate") ?? initialFilters.toDate ?? "");
    if (!date) return;
    updateFilters({ toDate: date + (e.target.value ? "T" + e.target.value : "") });
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
  const fromParts = splitDateTime(currentFrom);
  const toParts = splitDateTime(currentTo);

  // Records, page size and times are used rarely, so they sit behind "More filters".
  // Open it automatically when any of them is set to a non-default value.
  const hasMoreFilters =
    currentArchive !== "active" ||
    currentPageSize !== "10" ||
    Boolean(fromParts.time || toParts.time);
  const [moreOpen, setMoreOpen] = useState(hasMoreFilters);

  const inputClass =
    "h-10 w-full rounded-lg border border-border bg-white px-3 text-sm text-ink outline-none focus:border-gold focus:ring-4 focus:ring-gold/10";
  const labelClass =
    "mb-1 block text-[11px] font-bold uppercase tracking-[0.1em] text-muted";

  return (
    <form
      action={submitReservationSearch}
      className="mt-4 rounded-2xl border border-border bg-white p-3 shadow-card"
      onSubmit={() => {
        if (debounceTimerRef.current) {
          clearTimeout(debounceTimerRef.current);
        }
      }}
    >
      <input
        name="liveBatch"
        type="hidden"
        value={initialFilters.liveBatch ?? ""}
      />
      <input
        name="sort"
        type="hidden"
        value={searchParams.get("sort") ?? initialFilters.sort ?? ""}
      />
      <input
        name="direction"
        type="hidden"
        value={searchParams.get("direction") ?? initialFilters.direction ?? ""}
      />
      <input name="status" type="hidden" value={currentStatus} />
      {/* Carries the full From/To value, date plus optional time, on submit. */}
      <input name="fromDate" type="hidden" value={currentFrom} />
      <input name="toDate" type="hidden" value={currentTo} />
      <input
        name="payment"
        type="hidden"
        value={searchParams.get("payment") ?? initialFilters.payment ?? "all"}
      />

      <div className="grid items-end gap-2 sm:grid-cols-2 lg:grid-cols-[minmax(220px,1fr)_150px_150px_auto]">
        <label className="block sm:col-span-2 lg:col-span-1" htmlFor="reservation-search">
          <span className={labelClass + " flex items-center justify-between"}>
            <span>Search</span>
            {isPending && (
              <span className="text-[10px] font-normal normal-case text-gold">
                searching...
              </span>
            )}
          </span>
          <input
            className={inputClass}
            id="reservation-search"
            name="q"
            onChange={handleSearchChange}
            placeholder="Customer, FB / CS name, SKU or item"
            type="search"
            value={searchTerm}
          />
        </label>
        <label className="block" htmlFor="reservation-from-date">
          <span className={labelClass}>From</span>
          <input
            className={inputClass}
            id="reservation-from-date"
            onChange={handleFromDateChange}
            type="date"
            value={fromParts.date}
          />
        </label>
        <label className="block" htmlFor="reservation-to-date">
          <span className={labelClass}>To</span>
          <input
            className={inputClass}
            id="reservation-to-date"
            onChange={handleToDateChange}
            type="date"
            value={toParts.date}
          />
        </label>
        <div className="flex flex-wrap items-center gap-2 sm:col-span-2 lg:col-span-1">
          <button
            className="h-10 rounded-lg bg-ink px-4 text-sm font-bold text-white transition hover:bg-ink/90 disabled:opacity-50"
            disabled={isPending}
            type="submit"
          >
            {isPending ? "Filtering..." : "Filter"}
          </button>
          <button
            className="h-10 rounded-lg px-3 text-sm font-semibold text-muted transition hover:text-ink"
            formAction={clearReservationSearch}
            onClick={() => setSearchTerm("")}
            type="submit"
          >
            Reset
          </button>
          <button
            aria-controls="reservation-more-filters"
            aria-expanded={moreOpen}
            className={
              "h-10 rounded-lg px-3 text-sm font-semibold transition " +
              (hasMoreFilters ? "text-gold-dark" : "text-muted hover:text-ink")
            }
            onClick={() => setMoreOpen((open) => !open)}
            type="button"
          >
            {moreOpen ? "Fewer filters" : "More filters"}
            {hasMoreFilters && !moreOpen ? " •" : ""}
          </button>
        </div>
      </div>

      <div
        className="mt-2 grid gap-2 border-t border-border pt-3 sm:grid-cols-2 lg:max-w-md"
        hidden={!moreOpen}
        id="reservation-more-filters"
      >
        <label className="block" htmlFor="reservation-archive">
          <span className={labelClass}>Records</span>
          <select
            className={inputClass}
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
        <label className="block" htmlFor="reservation-from-time">
          <span className={labelClass}>From time</span>
          <input
            className={inputClass}
            disabled={!fromParts.date}
            id="reservation-from-time"
            onChange={handleFromTimeChange}
            step={60}
            title={fromParts.date ? "" : "Pick a From date first"}
            type="time"
            value={fromParts.time}
          />
        </label>
        <label className="block" htmlFor="reservation-to-time">
          <span className={labelClass}>To time</span>
          <input
            className={inputClass}
            disabled={!toParts.date}
            id="reservation-to-time"
            onChange={handleToTimeChange}
            step={60}
            title={toParts.date ? "" : "Pick a To date first"}
            type="time"
            value={toParts.time}
          />
        </label>
        <label className="block" htmlFor="reservation-page-size">
          <span className={labelClass}>Customers per page</span>
          <select
            className={inputClass}
            id="reservation-page-size"
            name="pageSize"
            onChange={handlePageSizeChange}
            value={currentPageSize}
          >
            <option value="10">10 per page</option>
            <option value="20">20 per page</option>
            <option value="50">50 per page</option>
            <option value="all">See all</option>
          </select>
        </label>
      </div>
    </form>
  );
}
