import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  buildLiveOrderPreview,
  LIVE_IMPORT_MAX_BYTES,
  parseLiveOrderBuffer,
  type ImportCustomerCandidate,
  type ImportStockCandidate,
  type LiveImportPreview,
} from "@/lib/import/live-orders";
import type { Database } from "@/types/database";

const PAGE_SIZE = 1000;

async function loadAllCustomers(
  supabase: SupabaseClient<Database>,
): Promise<ImportCustomerCandidate[]> {
  const customers: ImportCustomerCandidate[] = [];

  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("customers")
      .select("id, name, facebook_name, created_at")
      .is("archived_at", null)
      .not("facebook_name", "is", null)
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error("Customer matching could not be completed.");
    customers.push(...(data ?? []));
    if (!data || data.length < PAGE_SIZE) break;
  }
  return customers;
}

async function loadAllCatalogStock(
  supabase: SupabaseClient<Database>,
): Promise<ImportStockCandidate[]> {
  const items: ImportStockCandidate[] = [];

  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .rpc("get_reservable_stock", { p_exclude_reservation_id: null })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error("The jewelry catalog could not be loaded.");
    items.push(...(data ?? []));
    if (!data || data.length < PAGE_SIZE) break;
  }
  return items;
}

export async function prepareLiveOrderPreview(
  supabase: SupabaseClient<Database>,
  file: File,
): Promise<LiveImportPreview> {
  if (!file || typeof file.arrayBuffer !== "function") {
    throw new Error("Choose a CSV or XLSX file.");
  }
  if (file.size > LIVE_IMPORT_MAX_BYTES) {
    throw new Error("The import file must be 5 MB or smaller.");
  }

  const parsed = await parseLiveOrderBuffer(
    Buffer.from(await file.arrayBuffer()),
    file.name,
  );
  const [customers, stockItems] = await Promise.all([
    loadAllCustomers(supabase),
    loadAllCatalogStock(supabase),
  ]);

  return buildLiveOrderPreview({
    parsed,
    customers,
    stockItems,
  });
}
