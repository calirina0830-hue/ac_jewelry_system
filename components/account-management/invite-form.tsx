"use client";

import { useActionState } from "react";

import { inviteAdminAccount } from "@/actions/account-management";
import {
  ActionMessage,
  FormField,
  SubmitButton,
} from "@/components/auth/form-controls";
import { INVITE_ROLES } from "@/lib/validation/accounts";
import type { FormActionState } from "@/types/forms";

const INITIAL_STATE: FormActionState = { status: "idle" };

const ROLE_OPTIONS: Record<(typeof INVITE_ROLES)[number], string> = {
  admin: "Admin — full operational access",
  staff: "Staff — create and edit",
  viewer: "Viewer — read only",
};

export function InviteForm() {
  const [state, formAction] = useActionState(
    inviteAdminAccount,
    INITIAL_STATE,
  );

  return (
    <section className="rounded-2xl border border-border bg-white p-6 shadow-card">
      <h2 className="font-serif text-xl text-ink">Invite a new account</h2>
      <p className="mt-1 text-sm text-muted">
        Creates the sign-in account and emails a link for the person to set
        their own password. No passwords pass through this system.
      </p>
      <form action={formAction} className="mt-5 space-y-4" noValidate>
        <ActionMessage state={state} />
        <div className="grid gap-4 md:grid-cols-2">
          <FormField
            autoCapitalize="none"
            error={state.fieldErrors?.username}
            label="Username"
            name="username"
            placeholder="e.g. Tonyo"
          />
          <FormField
            autoComplete="email"
            error={state.fieldErrors?.email}
            label="Email"
            name="email"
            placeholder="name@example.com"
            type="email"
          />
          <FormField
            error={state.fieldErrors?.fullName}
            label="Full name"
            name="fullName"
            placeholder="e.g. Antonio Reyes"
          />
          <label
            className="block text-sm font-semibold text-ink"
            htmlFor="invite-role"
          >
            Role
            <select
              className="mt-2 block h-12 w-full rounded-xl border border-border bg-white px-4 text-[15px] font-normal text-ink outline-none transition focus:border-gold focus:ring-4 focus:ring-gold/10"
              defaultValue="admin"
              id="invite-role"
              name="role"
            >
              {INVITE_ROLES.map((role) => (
                <option key={role} value={role}>
                  {ROLE_OPTIONS[role]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="max-w-xs">
          <SubmitButton>Create account &amp; send invite</SubmitButton>
        </div>
      </form>
    </section>
  );
}
