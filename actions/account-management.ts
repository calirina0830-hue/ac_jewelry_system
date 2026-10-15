"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { logActivity } from "@/lib/activity";
import { authorizeRoles } from "@/lib/auth";
import { getSiteUrl } from "@/lib/site-url";
import { createClient } from "@/lib/supabase/server";
import {
  accountIdSchema,
  accountRoleChangeSchema,
  accountStatusChangeSchema,
  inviteAccountSchema,
} from "@/lib/validation/accounts";
import { getFieldErrors } from "@/lib/validation/form-errors";
import type { FormActionState } from "@/types/forms";

const ACCOUNT_MANAGEMENT_ROLES = ["owner", "developer"] as const;

function unauthorizedState(): FormActionState {
  return {
    status: "error",
    message: "Only the developer and owner may manage accounts.",
  };
}

const RPC_ERROR_MESSAGES: Record<string, string> = {
  owner_only:
    "Only the developer and owner may perform this action.",
  self_change_forbidden: "You cannot change your own account here.",
  account_not_found: "That account no longer exists.",
  invalid_role: "That role is not allowed.",
  invalid_username: "Choose a different username.",
  username_taken: "That username is already in use.",
  invalid_email: "Enter a valid email address.",
  email_taken: "An account already exists with that email address.",
  invalid_full_name: "Full name must be between 2 and 120 characters.",
};

function rpcMessage(error: { message?: string | null } | null): string | null {
  const raw = error?.message ?? "";
  const key = raw.split(":")[0]?.trim();
  return key ? RPC_ERROR_MESSAGES[key] ?? null : null;
}

async function sendInviteResetEmail(email: string): Promise<string | null> {
  const supabase = await createClient();
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: getSiteUrl() + "/auth/callback?next=/reset-password",
  });

  if (!error) return null;
  if (error.status === 429) {
    return "The reset email was rate limited. Use Send reset link shortly.";
  }
  console.error("Invite reset email failed", error.status);
  return "The account was created but the setup email failed. Use Send reset link.";
}

export async function inviteAdminAccount(
  _previousState: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const authorization = await authorizeRoles(ACCOUNT_MANAGEMENT_ROLES);

  if (!authorization) {
    return unauthorizedState();
  }

  const parsed = inviteAccountSchema.safeParse({
    username: formData.get("username"),
    email: formData.get("email"),
    fullName: formData.get("fullName"),
    role: formData.get("role"),
  });

  if (!parsed.success) {
    return {
      status: "error",
      message: "Please correct the highlighted fields.",
      fieldErrors: getFieldErrors(parsed.error),
    };
  }

  const supabase = await createClient();
  const { data: userId, error } = await supabase.rpc(
    "create_admin_account",
    {
      p_username: parsed.data.username,
      p_email: parsed.data.email,
      p_full_name: parsed.data.fullName,
      p_role: parsed.data.role,
    },
  );

  if (error || !userId) {
    console.error("Account creation failed", {
      code: error?.code,
      message: error?.message,
    });
    return {
      status: "error",
      message:
        rpcMessage(error) ??
        "The account could not be created. Please try again.",
    };
  }

  revalidatePath("/account-management");

  const emailProblem = await sendInviteResetEmail(parsed.data.email);
  await logActivity(supabase, {
    action: "password_reset_sent",
    entityType: "account",
    entityId: userId,
    description:
      "Sent password setup link to " + parsed.data.username + ".",
  });

  return {
    status: "success",
    message: emailProblem
      ? "Account created for " +
        parsed.data.username +
        ". " +
        emailProblem
      : "Account created for " +
        parsed.data.username +
        ". They will receive an email to set their password.",
  };
}

export async function setAccountStatus(formData: FormData): Promise<void> {
  const authorization = await authorizeRoles(ACCOUNT_MANAGEMENT_ROLES);
  const parsed = accountStatusChangeSchema.safeParse({
    userId: formData.get("userId"),
    isActive: formData.get("isActive"),
  });

  if (!authorization || !parsed.success) {
    redirect("/account-management?error=not-authorized");
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("set_account_status", {
    p_user_id: parsed.data.userId,
    p_is_active: parsed.data.isActive,
  });

  if (error) {
    console.error("Account status change failed", {
      code: error.code,
      message: error.message,
    });
    redirect(
      "/account-management?error=" +
        encodeURIComponent(rpcMessage(error) ?? "status-change-failed"),
    );
  }

  revalidatePath("/account-management");
  redirect(
    "/account-management?message=" +
      encodeURIComponent(
        parsed.data.isActive
          ? "Account activated."
          : "Account disabled. Their sessions end on next request.",
      ),
  );
}

export async function setAccountRole(formData: FormData): Promise<void> {
  const authorization = await authorizeRoles(ACCOUNT_MANAGEMENT_ROLES);
  const parsed = accountRoleChangeSchema.safeParse({
    userId: formData.get("userId"),
    newRole: formData.get("newRole"),
  });

  if (!authorization || !parsed.success) {
    redirect("/account-management?error=not-authorized");
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("set_account_role", {
    p_user_id: parsed.data.userId,
    p_new_role: parsed.data.newRole,
  });

  if (error) {
    console.error("Account role change failed", {
      code: error.code,
      message: error.message,
    });
    redirect(
      "/account-management?error=" +
        encodeURIComponent(rpcMessage(error) ?? "role-change-failed"),
    );
  }

  revalidatePath("/account-management");
  redirect(
    "/account-management?message=" +
      encodeURIComponent("Role changed to " + parsed.data.newRole + "."),
  );
}

export async function sendPasswordReset(formData: FormData): Promise<void> {
  const authorization = await authorizeRoles(ACCOUNT_MANAGEMENT_ROLES);
  const parsedId = accountIdSchema.safeParse(formData.get("userId"));

  if (!authorization || !parsedId.success) {
    redirect("/account-management?error=not-authorized");
  }

  const supabase = await createClient();
  const { data: accounts } = await supabase.rpc(
    "list_account_management_profiles",
  );
  const account = accounts?.find((entry) => entry.id === parsedId.data);

  if (!account?.email) {
    redirect("/account-management?error=account-not-found");
  }

  const emailProblem = await sendInviteResetEmail(account.email);
  await logActivity(supabase, {
    action: "password_reset_sent",
    entityType: "account",
    entityId: account.id,
    description:
      "Sent password reset link to " + (account.username ?? account.email) + ".",
  });

  revalidatePath("/account-management");

  if (emailProblem) {
    redirect("/account-management?error=" + encodeURIComponent(emailProblem));
  }

  redirect(
    "/account-management?message=password-reset-sent",
  );
}
