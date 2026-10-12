"use client";

import { useActionState } from "react";

import {
  forgotPasswordAction,
  loginAction,
  resetPasswordAction,
} from "@/actions/auth";
import {
  ActionMessage,
  FormField,
  SubmitButton,
} from "@/components/auth/form-controls";
import { INITIAL_AUTH_STATE } from "@/types/auth";

export function LoginForm({
  next,
  initialMessage,
  initialMessageStatus = "success",
}: {
  next?: string;
  initialMessage?: string;
  initialMessageStatus?: "error" | "success";
}) {
  const [state, formAction] = useActionState(
    loginAction,
    INITIAL_AUTH_STATE,
  );

  return (
    <form action={formAction} className="space-y-5" noValidate>
      {initialMessage && (
        <div
          className={
            "rounded-xl border px-4 py-3 text-sm leading-6 " +
            (initialMessageStatus === "error"
              ? "border-red-200 bg-red-50 text-red-800"
              : "border-emerald-200 bg-emerald-50 text-emerald-800")
          }
          role={initialMessageStatus === "error" ? "alert" : "status"}
        >
          {initialMessage}
        </div>
      )}
      <ActionMessage state={state} />
      <input name="next" type="hidden" value={next ?? "/dashboard"} />
      <FormField
        autoComplete="username"
        autoCapitalize="none"
        error={state.fieldErrors?.username}
        label="Email or Username"
        name="username"
        placeholder="Enter your email or username"
      />
      <FormField
        autoComplete="current-password"
        error={state.fieldErrors?.password}
        label="Password"
        name="password"
        placeholder="Enter your password"
        type="password"
      />
      <SubmitButton>Sign in securely</SubmitButton>
    </form>
  );
}

export function ForgotPasswordForm() {
  const [state, formAction] = useActionState(
    forgotPasswordAction,
    INITIAL_AUTH_STATE,
  );

  return (
    <form action={formAction} className="space-y-5" noValidate>
      <ActionMessage state={state} />
      <FormField
        autoComplete="username"
        autoCapitalize="none"
        error={state.fieldErrors?.username}
        label="Email or Username"
        name="username"
        placeholder="Enter your email or username"
      />
      <SubmitButton>Send reset instructions</SubmitButton>
    </form>
  );
}

export function ResetPasswordForm() {
  const [state, formAction] = useActionState(
    resetPasswordAction,
    INITIAL_AUTH_STATE,
  );

  return (
    <form action={formAction} className="space-y-5" noValidate>
      <ActionMessage state={state} />
      <FormField
        autoComplete="new-password"
        error={state.fieldErrors?.password}
        label="New password"
        minLength={8}
        name="password"
        placeholder="At least 8 characters"
        type="password"
      />
      <FormField
        autoComplete="new-password"
        error={state.fieldErrors?.confirmPassword}
        label="Confirm new password"
        minLength={8}
        name="confirmPassword"
        placeholder="Repeat your new password"
        type="password"
      />
      <SubmitButton>Update password</SubmitButton>
    </form>
  );
}
