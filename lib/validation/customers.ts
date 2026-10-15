import { z } from "zod";

const normalizeTextInput = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

// Match PostgreSQL char_length(), which counts Unicode code points rather
// than JavaScript UTF-16 code units. This keeps text limits consistent for
// supplementary-plane scripts and emoji without imposing a language rule.
const unicodeLength = (value: string) => Array.from(value).length;

const optionalText = (maximum: number, label: string) =>
  z.preprocess(
    normalizeTextInput,
    z.string().refine(
      (value) => unicodeLength(value) <= maximum,
      label + " is too long.",
    ),
  ).transform((value) => value || null);

function isValidPhilippinePhone(value: string): boolean {
  if (value === "") {
    return true;
  }

  const compactPhone = value.replace(/[\s()-]/g, "");

  return /^(?:09\d{9}|\+639\d{9}|0[2-8]\d{7,9}|\+63[2-8]\d{7,9})$/.test(
    compactPhone,
  );
}

const optionalPhone = z
  .preprocess(
    normalizeTextInput,
    z
      .string()
      .max(40, "Phone is too long.")
      .refine(isValidPhilippinePhone, "Enter a valid phone number."),
  )
  .transform((value) => value || null);

export const customerFormSchema = z.object({
  name: z.preprocess(
    normalizeTextInput,
    z
      .string()
      .refine(
        (value) => unicodeLength(value) >= 1,
        "Name must contain at least 1 character.",
      )
      .refine(
        (value) => unicodeLength(value) <= 160,
        "Name must be 160 characters or fewer.",
      ),
  ),
  facebookName: optionalText(160, "Facebook / CS name"),
  phone: optionalPhone,
  address: optionalText(1000, "Address"),
  notes: optionalText(4000, "Notes"),
});

export const createCustomerSchema = customerFormSchema;

export const updateCustomerSchema = customerFormSchema.extend({
  id: z.string().uuid("Invalid customer identifier."),
  updatedAt: z.iso.datetime({
    offset: true,
    error: "Invalid customer version.",
  }),
});

export const customerIdSchema = z.string().uuid();

export const customerQuerySchema = z.object({
  q: z.string().trim().max(100).catch(""),
  status: z.enum(["active", "archived", "all"]).catch("active"),
  sort: z
    .enum(["name", "facebook_name", "phone", "created_at"])
    .catch("created_at"),
  direction: z.enum(["asc", "desc"]).catch("desc"),
  page: z.coerce.number().int().min(1).catch(1),
});
