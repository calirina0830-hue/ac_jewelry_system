import Link from "next/link";
import type { ReactNode } from "react";

import { toSearchParams } from "@/lib/query";

export function SortLink({
  pathname,
  column,
  activeColumn,
  direction,
  query,
  children,
}: {
  pathname: string;
  column: string;
  activeColumn: string;
  direction: "asc" | "desc";
  query: Record<string, string | number | undefined>;
  children: ReactNode;
}) {
  const nextDirection =
    activeColumn === column && direction === "asc" ? "desc" : "asc";
  const href =
    pathname +
    "?" +
    toSearchParams({
      ...query,
      sort: column,
      direction: nextDirection,
      page: 1,
    }).toString();

  return (
    <Link className="inline-flex items-center gap-1 hover:text-gold-dark" href={href}>
      {children}
      {activeColumn === column && (
        <span aria-hidden="true">{direction === "asc" ? "↑" : "↓"}</span>
      )}
    </Link>
  );
}
