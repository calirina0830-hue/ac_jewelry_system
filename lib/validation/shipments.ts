import { z } from "zod";

export const shipmentIdSchema = z.string().uuid();

export const shipmentQuerySchema = z.object({
  q: z.string().trim().max(100).catch(""),
  status: z.enum(["all", "pending", "shipped", "cancelled"]).catch("all"),
  page: z.coerce.number().int().min(1).catch(1),
});

export const shipmentItemSchema = z.object({
  reservationItemId: z.string().uuid("Invalid reservation item."),
  quantity: z.coerce
    .number()
    .int("Enter a whole-number quantity.")
    .min(1, "Quantity must be at least 1.")
    .max(2_147_483_647, "Quantity is too large."),
});

export const prepareShipmentSchema = z.object({
  reservationId: z.string().uuid(),
  items: z
    .array(shipmentItemSchema)
    .min(1, "Select at least one item to ship.")
    .max(200, "A single shipment can contain at most 200 items.")
    .superRefine((items, context) => {
      const seen = new Set<string>();
      items.forEach((item, index) => {
        if (seen.has(item.reservationItemId)) {
          context.addIssue({
            code: "custom",
            message: "Each item can only be shipped once per shipment.",
            path: [index, "reservationItemId"],
          });
        }
        seen.add(item.reservationItemId);
      });
    }),
});

export const downpaymentAppliedSchema = z
  .string()
  .trim()
  .refine(
    (value) => /^\d{1,10}(?:\.\d{1,2})?$/.test(value),
    "Enter a valid downpayment amount.",
  );

export const prepareReleaseSchema = prepareShipmentSchema.extend({
  downpaymentApplied: z.preprocess(
    (value) =>
      value === null || value === undefined || value === "" ? "0" : value,
    downpaymentAppliedSchema,
  ),
});

export const releaseItemsSchema = prepareReleaseSchema.extend({
  downpaymentApplied: z.preprocess(
    (value) =>
      value === null || value === undefined || value === "" ? "0" : value,
    downpaymentAppliedSchema.refine(
      (value) => Number(value) > 0,
      "A downpayment greater than ₱0.00 is required to release items.",
    ),
  ),
  releaseDate: z.string().trim().min(1, "Enter a valid release date."),
  notes: z.string().trim().max(2000, "Notes cannot exceed 2000 characters.").optional(),
});

export const cancelShipmentSchema = z.object({
  reservationId: z.string().uuid(),
  shipmentId: shipmentIdSchema,
  reason: z.string().trim().max(1000).optional(),
});

export const editShipmentSchema = z.object({
  reservationId: z.string().uuid(),
  shipmentId: shipmentIdSchema,
  expectedUpdatedAt: z.iso.datetime({ offset: true }),
  shippedAt: z.iso.datetime({ offset: true }),
  notes: z.string().trim().max(2000).optional(),
  correctionReason: z.string()
    .trim()
    .min(3, "Enter a correction reason.")
    .max(1000, "Correction remarks cannot exceed 1000 characters."),
});

export const orderedAtSchema = z.object({
  reservationId: z.string().uuid(),
  reservationItemId: z.string().uuid(),
  orderedAt: z.iso.datetime({
    offset: true,
    error: "Invalid order date and time.",
  }),
});
