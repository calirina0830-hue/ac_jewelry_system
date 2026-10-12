import { z } from "zod";

const password = z
  .string()
  .min(8, "Password must be at least 8 characters.")
  .max(72, "Password must be 72 characters or fewer.");

const username = z
  .string()
  .trim()
  .min(1, "Email or username is required.")
  .max(254, "Email or username is too long.");

export const loginSchema = z.object({
  username,
  password: z.string().min(1, "Password is required."),
  next: z.string().optional(),
});

export const forgotPasswordSchema = z.object({ username });

export const resetPasswordSchema = z
  .object({
    password,
    confirmPassword: z.string(),
  })
  .refine((values) => values.password === values.confirmPassword, {
    message: "Passwords do not match.",
    path: ["confirmPassword"],
  });
