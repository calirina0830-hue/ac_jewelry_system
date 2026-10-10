"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ZodError } from "zod";

import { logActivity } from "@/lib/activity";
import { getSafeRedirectPath } from "@/lib/redirects";
import { getSiteUrl } from "@/lib/site-url";
import { logSupabaseDiagnostics } from "@/lib/supabase/config";
import { createClient } from "@/lib/supabase/server";
import {
  forgotPasswordSchema,
  loginSchema,
  resetPasswordSchema,
} from "@/lib/validation/auth";
import type { AuthActionState } from "@/types/auth";

function getFieldErrors(error: ZodError): Record<string, string[]> {
  const errors: Record<string, string[]> = {};

  for (const issue of error.issues) {
    const field = String(issue.path[0] ?? "form");
    errors[field] = [...(errors[field] ?? []), issue.message];
  }

  return errors;
}

function validationError(error: ZodError): AuthActionState {
  return {
    status: "error",
    message: "Please correct the highlighted fields.",
    fieldErrors: getFieldErrors(error),
  };
}

type LoginIdentity = {
  email: string;
};

// Resolves the Supabase Auth email behind a public username. Directory
// accounts resolve through a trusted database lookup; deployments that have
// not assigned usernames yet keep working through the configured environment
// administrator.
async function resolveLoginEmail(
  username: string,
): Promise<LoginIdentity | null> {
  const supabase = await createClient();
  const { data } = await supabase.rpc("get_login_identity", { p_username: username });
  const identity = data?.[0];

  if (identity?.email) {
    return { email: identity.email };
  }

  const configuredUsername =
    process.env.ADMIN_LOGIN_USERNAME?.trim().toLowerCase();
  const configuredEmail = process.env.ADMIN_LOGIN_EMAIL?.trim().toLowerCase();

  if (
    configuredUsername &&
    configuredEmail &&
    username.toLowerCase() === configuredUsername
  ) {
    return { email: configuredEmail };
  }

  return null;
}

export async function loginAction(
  _previousState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const parsed = loginSchema.safeParse({
    username: formData.get("username"),
    password: formData.get("password"),
    next: formData.get("next"),
  });

  if (!parsed.success) {
    return validationError(parsed.error);
  }

  const identity = await resolveLoginEmail(parsed.data.username);

  if (!identity) {
    return {
      status: "error",
      message: "Username or password is incorrect.",
    };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: identity.email,
    password: parsed.data.password,
  });

  if (error) {
    return {
      status: "error",
      message:
        error.code === "email_not_confirmed"
          ? "The account must be verified before signing in."
          : "Username or password is incorrect.",
    };
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    await supabase.auth.signOut();
    return {
      status: "error",
      message: "Username or password is incorrect.",
    };
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("username, full_name, role, is_active")
    .eq("id", user.id)
    .maybeSingle();

  if (
    !profile ||
    !(
      profile.role === "admin" ||
      profile.role === "owner" ||
      profile.role === "developer"
    ) ||
    !profile.is_active
  ) {
    await supabase.auth.signOut();
    return {
      status: "error",
      message: profile && !profile.is_active
        ? "This account has been disabled. Contact the system owner."
        : "Username or password is incorrect.",
    };
  }

  revalidatePath("/", "layout");
  await logActivity(supabase, {
    action: "login",
    entityType: "auth",
    description:
      (profile.full_name || parsed.data.username) + " signed in.",
  });
  redirect(getSafeRedirectPath(parsed.data.next));
}

export async function forgotPasswordAction(
  _previousState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const parsed = forgotPasswordSchema.safeParse({
    username: formData.get("username"),
  });

  if (!parsed.success) {
    return validationError(parsed.error);
  }

  const identity = await resolveLoginEmail(parsed.data.username);

  if (!identity) {
    return {
      status: "success",
      message:
        "If that account exists, password reset instructions are on the way.",
    };
  }

  const redirectTo = getSiteUrl() + "/auth/callback?next=/reset-password";
  logSupabaseDiagnostics({ context: "forgot-password", redirectTo });

  const supabase = await createClient();
  const { error } = await supabase.auth.resetPasswordForEmail(
    identity.email,
    { redirectTo },
  );

  if (error && error.status === 429) {
    return {
      status: "error",
      message: "Too many reset requests. Please wait a moment and try again.",
    };
  }

  if (error) {
    return {
      status: "error",
      message: "We could not send reset instructions. Please try again.",
    };
  }

  return {
    status: "success",
    message:
      "If that account exists, password reset instructions are on the way.",
  };
}

export async function resetPasswordAction(
  _previousState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const parsed = resetPasswordSchema.safeParse({
    password: formData.get("password"),
    confirmPassword: formData.get("confirmPassword"),
  });

  if (!parsed.success) {
    return validationError(parsed.error);
  }

  const supabase = await createClient();
  const { data: claimsData } = await supabase.auth.getClaims();

  if (!claimsData?.claims) {
    return {
      status: "error",
      message: "This reset link is invalid or expired. Request a new one.",
    };
  }

  const { error } = await supabase.auth.updateUser({
    password: parsed.data.password,
  });

  if (error) {
    return {
      status: "error",
      message: "We could not update your password. Request a new reset link.",
    };
  }

  await supabase.auth.signOut();
  revalidatePath("/", "layout");
  redirect("/login?message=password-updated");
}

export async function logoutAction(): Promise<void> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("full_name")
      .eq("id", user.id)
      .maybeSingle();

    await logActivity(supabase, {
      action: "logout",
      entityType: "auth",
      description:
        (profile?.full_name || user.email?.split("@")[0] || "User") +
        " signed out.",
    });
  }

  await supabase.auth.signOut();
  revalidatePath("/", "layout");
  redirect("/login");
}
