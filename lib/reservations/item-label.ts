// Items typed by hand are stored with a generated code. The code exists only
// because the database links every order line to an entry, so it is never
// shown: every item displays as exactly what was entered, without its code
// or category.
export const MANUAL_ITEM_SKU_PREFIX = "ITEM-";
export const MANUAL_ITEM_CATEGORY = "Item";

export function formatItemLabel(item: {
  sku: string | null | undefined;
  name: string | null | undefined;
  category: string | null | undefined;
}): string {
  return item.name?.trim() || item.sku || "";
}
