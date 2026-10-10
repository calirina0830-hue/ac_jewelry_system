export const STOCK_CATEGORIES = [
  "Ring",
  "Necklace",
  "Bracelet",
  "Earrings",
  "Pendant",
  "Anklet",
  "Watch",
  "Set",
  "Others",
] as const;

export type StockCategory = (typeof STOCK_CATEGORIES)[number];

export const LOW_STOCK_THRESHOLD = 5;
export const STOCK_IMAGE_BUCKET = "stock-images";
export const MAX_STOCK_IMAGE_BYTES = 5 * 1024 * 1024;
export const STOCK_IMAGE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;
