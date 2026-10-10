import { z } from "zod";

import { parseDateOnlyToUtcIso } from "@/lib/dates";
import { ACTIVITY_ACTIONS, ACTIVITY_MODULES } from "@/lib/constants/activity";

const username = z
  .string()
  .trim()
  .min(2, "Username must be at least 2 characters.")
  .max(64, "Username is too long.")
  .regex(
    /^[a-zA-Z0-9._-]+$/,
    "Username may only contain letters, numbers, dots, underscores, and hyphens.",
  );

const email = z
  .string()
  .trim()
  .min(3, "Email is required.")
  .max(254, "Email is too long.")
  .regex(
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    "Enter a valid email address.",
  );

export const INVITE_ROLES = ["admin", "staff", "viewer"] as const;

export const inviteAccountSchema = z.object({
  username,
  email,
  fullName: z
    .string()
    .trim()
    .min(2, "Full name must be at least 2 characters.")
    .max(120, "Full name is too long."),
  role: z.enum(INVITE_ROLES),
});

export const accountIdSchema = z.string().uuid("Invalid account identifier.");

// Operational roles only: no UI path may grant developer or owner.
export const ACCOUNT_TARGET_ROLES = ["admin", "staff", "viewer"] as const;

export const accountRoleChangeSchema = z.object({
  userId: accountIdSchema,
  newRole: z.enum(ACCOUNT_TARGET_ROLES),
});

export const accountStatusChangeSchema = z.object({
  userId: accountIdSchema,
  isActive: z.enum(["true", "false"]).transform((value) => value === "true"),
});

const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the YYYY-MM-DD date format.")
  .refine((value) => parseDateOnlyToUtcIso(value) !== null, {
    message: "Enter a real calendar date.",
  });

export const activityQuerySchema = z.object({
  user: z
    .string()
    .uuid("Invalid user filter.")
    .optional()
    .catch(undefined),
  from: dateString.optional().catch(undefined),
  to: dateString.optional().catch(undefined),
  module: z
    .enum(ACTIVITY_MODULES)
    .optional()
    .catch(undefined),
  action: z
    .enum(ACTIVITY_ACTIONS)
    .optional()
    .catch(undefined),
  q: z
    .string()
    .trim()
    .max(100, "Search term is too long.")
    .optional()
    .catch(undefined),
  page: z.coerce.number().int().min(1).max(10000).default(1).catch(1),
});
