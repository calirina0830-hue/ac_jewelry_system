import { z } from "zod";

import {
  MAX_PAYMENT_EVIDENCE_ATTACHMENTS,
  MAX_PAYMENT_EVIDENCE_BYTES,
  PAYMENT_EVIDENCE_MIME_TYPES,
} from "@/lib/constants/payments";
import { MAX_MONEY_CENTS } from "@/lib/constants/reservations";
import { parseMoneyToCents } from "@/lib/reservations/money";

const optionalText = (maximum: number, message: string) =>
  z
    .string()
    .trim()
    .max(maximum, message)
    .transform((value) => value || null);

export const paymentEntrySchema = z.object({
  reservationId: z.string().uuid(),
  expectedUpdatedAt: z.iso.datetime({ offset: true }),
  amount: z
    .string()
    .trim()
    .regex(/^\d{1,10}(?:\.\d{1,2})?$/, "Enter a valid payment amount.")
    .transform((value, context) => {
      const cents = parseMoneyToCents(value);
      if (cents === null || cents < 1 || cents > MAX_MONEY_CENTS) {
        context.addIssue({
          code: "custom",
          message: "Payment amount must be greater than zero.",
        });
        return z.NEVER;
      }
      return cents;
    }),
  paymentMethod: optionalText(120, "Payment method is too long."),
  referenceNo: optionalText(200, "Reference number is too long."),
  notes: optionalText(2000, "Payment notes are too long."),
});

export const paymentEvidenceMetadataSchema = z
  .object({
    storage_path: z.string().trim().min(1).max(512),
    original_file_name: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .refine((value) => !/[\u0000-\u001f\u007f]/.test(value)),
    mime_type: z.enum(PAYMENT_EVIDENCE_MIME_TYPES),
    file_size: z.number().int().min(1).max(MAX_PAYMENT_EVIDENCE_BYTES),
  })
  .strict();

export const paymentEvidenceListSchema = z
  .array(paymentEvidenceMetadataSchema)
  .max(MAX_PAYMENT_EVIDENCE_ATTACHMENTS);

export const paymentBatchIdsSchema = z
  .array(z.string().uuid())
  .min(1)
  .max(50)
  .refine((ids) => new Set(ids).size === ids.length);

export const revertReasonSchema = z
  .string()
  .trim()
  .min(3, "Enter a reason for reverting these payments.")
  .max(1000, "Reversion reason is too long.");
