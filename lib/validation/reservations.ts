import { z } from "zod";

import {
  MAX_MONEY_CENTS,
  MAX_RESERVATION_ITEMS,
  RESERVATION_STATUSES,
} from "@/lib/constants/reservations";
import { parseMoneyToCents } from "@/lib/reservations/money";

const normalizeTextInput = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

const optionalIdentifier = z.preprocess(
  (value) => {
    const normalized = normalizeTextInput(value);
    return normalized || undefined;
  },
  z.string().uuid("Invalid reservation item identifier.").optional(),
);

function moneyInput(label: string) {
  return z
    .preprocess(
      (value) => normalizeTextInput(value) || "0",
      z
        .string()
        .regex(
          /^\d{1,10}(?:\.\d{1,2})?$/,
          label + " must be a non-negative amount with up to 2 decimals.",
        ),
    )
    .transform((value, context) => {
      const cents = parseMoneyToCents(value);

      if (cents === null || cents > MAX_MONEY_CENTS) {
        context.addIssue({
          code: "custom",
          message: label + " is too large.",
        });
        return z.NEVER;
      }

      return cents;
    });
}

function requiredMoneyInput(message: string) {
  return z
    .preprocess(
      normalizeTextInput,
      z.string().regex(
        /^\d{1,10}(?:\.\d{1,2})?$/,
        message,
      ),
    )
    .transform((value, context) => {
      const cents = parseMoneyToCents(value);
      if (cents === null || cents > MAX_MONEY_CENTS) {
        context.addIssue({ code: "custom", message });
        return z.NEVER;
      }
      return cents;
    });
}

export const reservationItemInputSchema = z.object({
  reservationItemId: optionalIdentifier,
  // Present on lines kept as they were; typed lines send itemName instead.
  stockItemId: z.preprocess(
    (value) => (typeof value === "string" && value.trim() ? value.trim() : undefined),
    z.string().uuid("Enter the item.").optional(),
  ),
  itemName: z.preprocess(
    (value) =>
      typeof value === "string" ? value.trim().replace(/\s+/g, " ") : undefined,
    z.string().optional(),
  ),
  quantity: z.coerce
    .number()
    .int("Enter a whole-number quantity.")
    .min(1, "Quantity must be at least 1.")
    .max(2_147_483_647, "Quantity is too large."),
  sellingPrice: requiredMoneyInput("Enter a valid selling price."),
  discount: moneyInput("Line discount"),
  orderedAt: z
    .preprocess(
      (value) => (typeof value === "string" && value.trim() ? value.trim() : undefined),
      z.iso.datetime({ offset: true }).optional(),
    )
    .optional(),
}).superRefine((item, context) => {
  if (!item.stockItemId) {
    const length = item.itemName?.length ?? 0;
    if (length < 2 || length > 160) {
      context.addIssue({
        code: "custom",
        message: length ? "Item must be 2 to 160 characters." : "Enter the item.",
        path: ["itemName"],
      });
    }
  }
  if (item.discount > item.sellingPrice * item.quantity) {
    context.addIssue({
      code: "custom",
      message: "Discount cannot exceed the line subtotal.",
      path: ["discount"],
    });
  }
});

const reservationFieldsSchema = z
  .object({
    customerId: z.string().uuid("Select a customer."),
    reservationDiscount: moneyInput("Reservation discount"),
    downpayment: moneyInput("Downpayment"),
    notes: z
      .preprocess(
        normalizeTextInput,
        z.string().max(4000, "Notes are too long."),
      )
      .transform((value) => value || null),
    items: z
      .array(reservationItemInputSchema)
      .min(1, "Add at least one reservation item.")
      .max(
        MAX_RESERVATION_ITEMS,
        "A reservation can contain at most " + MAX_RESERVATION_ITEMS + " items.",
      ),
  });

export const createReservationSchema = reservationFieldsSchema;

export const updateReservationSchema = reservationFieldsSchema.safeExtend({
  id: z.string().uuid("Invalid reservation identifier."),
  updatedAt: z.iso.datetime({
    offset: true,
    error: "Invalid reservation version.",
  }),
});

export const reservationInvoiceItemsSchema = z.object({
  id: z.string().uuid("Invalid reservation identifier."),
  updatedAt: z.iso.datetime({
    offset: true,
    error: "Invalid reservation version.",
  }),
  items: z.array(reservationItemInputSchema).max(
    MAX_RESERVATION_ITEMS,
    "A reservation can contain at most " + MAX_RESERVATION_ITEMS + " items.",
  ),
});

export const reservationIdSchema = z.string().uuid();

export const reservationStatusTransitionSchema = z.object({
  id: reservationIdSchema,
  newStatus: z.enum(RESERVATION_STATUSES),
  updatedAt: z.iso.datetime({
    offset: true,
    error: "Invalid reservation version.",
  }),
});

export const reservationInvoiceNotesSchema = z.object({
  id: reservationIdSchema,
  expectedUpdatedAt: z.iso.datetime({
    offset: true,
    error: "Invalid reservation version.",
  }),
  notes: z.string().trim().max(4000),
});

const reservationDateFilterSchema = z
  .string()
  .trim()
  // "YYYY-MM-DD" for a whole day, or "YYYY-MM-DDTHH:mm" for an exact time.
  .regex(/^\d{4}-\d{2}-\d{2}(T([01]\d|2[0-3]):[0-5]\d)?$/)
  .refine((value) => {
    const [year, month, day] = value.slice(0, 10).split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    );
  })
  .catch("");

export const reservationQuerySchema = z.object({
  q: z.string().trim().max(100).catch(""),
  liveBatch: z.string().trim().max(120).catch(""),
  fromDate: reservationDateFilterSchema,
  toDate: reservationDateFilterSchema,
  status: z
    .enum(["all", ...RESERVATION_STATUSES, "partially-paid"])
    .catch("reserved"),
  archive: z.enum(["active", "archived", "all"]).catch("active"),
  // Reserved tab only: which orders have no downpayment or a partial payment.
  payment: z.enum(["all", "no-downpayment", "partially-paid"]).catch("all"),
  sort: z
    .enum([
      "reservation_no",
      "customer_name",
      "item_count",
      "total",
      "downpayment",
      "balance",
      "reserved_at",
      "paid_at",
      "delivered_at",
      "cancelled_at",
    ])
    .catch("reserved_at"),
  direction: z.enum(["asc", "desc"]).catch("desc"),
  page: z.coerce.number().int().min(1).catch(1),
  pageSize: z.enum(["10", "20", "50", "all"]).catch("10"),
});
