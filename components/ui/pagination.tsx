import Link from "next/link";

import { toSearchParams } from "@/lib/query";

type PaginationProps = {
  pathname: string;
  page: number;
  pageCount: number;
  query: Record<string, string | number | undefined>;
};

export function Pagination({
  pathname,
  page,
  pageCount,
  query,
}: PaginationProps) {
  if (pageCount <= 1) {
    return null;
  }

  const linkFor = (nextPage: number) =>
    pathname +
    "?" +
    toSearchParams({ ...query, page: nextPage }).toString();

  return (
    <nav
      className="flex items-center justify-between border-t border-border px-5 py-4"
      aria-label="Pagination"
    >
      <Link
        aria-disabled={page <= 1}
        className={
          "rounded-lg border border-border px-3 py-2 text-sm font-semibold " +
          (page <= 1
            ? "pointer-events-none text-muted/40"
            : "text-ink hover:border-gold")
        }
        href={linkFor(Math.max(1, page - 1))}
      >
        Previous
      </Link>
      <span className="text-sm text-muted">
        Page <strong className="text-ink">{page}</strong> of{" "}
        <strong className="text-ink">{pageCount}</strong>
      </span>
      <Link
        aria-disabled={page >= pageCount}
        className={
          "rounded-lg border border-border px-3 py-2 text-sm font-semibold " +
          (page >= pageCount
            ? "pointer-events-none text-muted/40"
            : "text-ink hover:border-gold")
        }
        href={linkFor(Math.min(pageCount, page + 1))}
      >
        Next
      </Link>
    </nav>
  );
}
