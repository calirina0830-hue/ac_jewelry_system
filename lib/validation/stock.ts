import { z } from "zod";

import { STOCK_CATEGORY_MAX_LENGTH } from "@/lib/constants/stock";

export const stockFormSchema = z.object({
  id: z.string().uuid("Invalid stock item identifier.").optional(),
  updatedAt: z.iso
    .datetime({ error: "Invalid stock item version.", offset: true })
    .optional(),
  sku: z
    .string()
    .trim()
    .min(1, "SKU is required.")
    .max(64, "SKU must be 64 characters or fewer.")
    .regex(/^[A-Za-z0-9._/-]+$/, "Use letters, numbers, dots, slashes, underscores, or hyphens.")
    .transform((value) => value.toUpperCase()),
  name: z
    .string()
    .trim()
    .min(2, "Item name must be at least 2 characters.")
    .max(160, "Item name must be 160 characters or fewer."),
  description: z
    .string()
    .trim()
    .max(4000, "Description is too long.")
    .transform((value) => value || null),
  category: z
    .string()
    .trim()
    .min(1, "Select a category.")
    .max(STOCK_CATEGORY_MAX_LENGTH, "Category is too long.")
    .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), {
      error: "Category contains invalid characters.",
    }),
  quantity: z.coerce
    .number()
    .int("Quantity must be a whole number.")
    .min(0, "Quantity cannot be negative.")
    .max(2_147_483_647, "Quantity is too large."),
  isActive: z.enum(["true", "false"]).transform((value) => value === "true"),
});

export const stockIdSchema = z.string().uuid();

export const stockQuerySchema = z.object({
  q: z.string().trim().max(100).catch(""),
  category: z.string().trim().min(1).max(STOCK_CATEGORY_MAX_LENGTH).catch("all"),
  status: z.enum(["active", "inactive", "archived", "all"]).catch("active"),
  sort: z
    .enum(["sku", "name", "category", "created_at"])
    .catch("created_at"),
  direction: z.enum(["asc", "desc"]).catch("desc"),
  page: z.coerce.number().int().min(1).catch(1),
});
