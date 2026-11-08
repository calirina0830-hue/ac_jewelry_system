// Items typed by hand are stored with a generated code. The code exists only
// because the database links every order line to an entry, so it is never
// shown: those items display as exactly what was typed.
export const MANUAL_ITEM_SKU_PREFIX = "ITEM-";
export const MANUAL_ITEM_CATEGORY = "Item";

export function formatItemLabel(item: {
  sku: string | null | undefined;
  name: string | null | undefined;
  category: string | null | undefined;
}): string {
  if (item.sku?.startsWith(MANUAL_ITEM_SKU_PREFIX)) {
    return item.name ?? "";
  }
  return [item.sku, item.name, item.category].filter(Boolean).join(" - ");
}
