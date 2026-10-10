export const NEW_STOCK_QUANTITY = 1;

export function resolveStockQuantity(existingQuantity?: number | null): number {
  if (existingQuantity === undefined || existingQuantity === null) {
    return NEW_STOCK_QUANTITY;
  }

  if (!Number.isInteger(existingQuantity) || existingQuantity < 0) {
    throw new Error("Invalid stored stock quantity.");
  }

  return existingQuantity;
}
