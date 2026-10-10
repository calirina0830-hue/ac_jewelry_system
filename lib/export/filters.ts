import type { ReservationStatus } from "@/types/database";

export type ReservationExportFilter = {
  q: string;
  liveBatch?: string;
  status: "all" | ReservationStatus;
  archive: "active" | "archived" | "all";
  itemMatchIds?: readonly string[];
};

export type ReservationExportSource = {
  id: string;
  reservation_no: string;
  customer_name: string;
  customer_facebook_name: string | null;
  status: ReservationStatus;
  archived_at: string | null;
  live_batch?: string | null;
};

export function filterReservationExportRows<T extends ReservationExportSource>(
  rows: readonly T[],
  filters: ReservationExportFilter,
): T[] {
  const search = filters.q.trim().toLocaleLowerCase();
  const itemMatchIds = filters.itemMatchIds
    ? new Set(filters.itemMatchIds)
    : undefined;

  return rows.filter((row) => {
    const matchesStatus =
      filters.status === "all" || row.status === filters.status;
    const matchesArchive =
      filters.archive === "all" ||
      (filters.archive === "active"
        ? row.archived_at === null
        : row.archived_at !== null);
    const matchesSearch =
      !search ||
      itemMatchIds?.has(row.id) ||
      row.reservation_no.toLocaleLowerCase().includes(search) ||
      row.customer_name.toLocaleLowerCase().includes(search) ||
      row.customer_facebook_name?.toLocaleLowerCase().includes(search);
    const matchesLiveBatch =
      !filters.liveBatch || row.live_batch === filters.liveBatch;

    return Boolean(
      matchesStatus && matchesArchive && matchesSearch && matchesLiveBatch,
    );
  });
}

export type StockExportFilter = {
  q: string;
  category: string;
  status: "active" | "inactive" | "archived" | "all";
};

export type StockExportSource = {
  sku: string;
  name: string;
  category: string;
  is_active: boolean;
  archived_at: string | null;
};

export function filterStockExportRows<T extends StockExportSource>(
  rows: readonly T[],
  filters: StockExportFilter,
): T[] {
  const search = filters.q.trim().toLocaleLowerCase();

  return rows.filter((row) => {
    const matchesSearch =
      !search ||
      row.sku.toLocaleLowerCase().includes(search) ||
      row.name.toLocaleLowerCase().includes(search);
    const matchesCategory =
      filters.category === "all" || row.category === filters.category;
    const matchesStatus =
      filters.status === "all" ||
      (filters.status === "archived"
        ? row.archived_at !== null
        : row.archived_at === null &&
          row.is_active === (filters.status === "active"));

    return matchesSearch && matchesCategory && matchesStatus;
  });
}
