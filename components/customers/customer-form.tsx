"use client";

import Link from "next/link";
import { useActionState } from "react";

import { createCustomer, updateCustomer } from "@/actions/customers";
import {
  FormSubmitButton,
  InputField,
  TextareaField,
} from "@/components/ui/form-elements";
import type { Database } from "@/types/database";
import { INITIAL_FORM_STATE } from "@/types/forms";

type Customer = Database["public"]["Tables"]["customers"]["Row"];

export function CustomerForm({ customer }: { customer?: Customer }) {
  const action = customer ? updateCustomer : createCustomer;
  const [state, formAction] = useActionState(action, INITIAL_FORM_STATE);

  return (
    <form action={formAction} className="space-y-6" noValidate>
      {customer && (
        <>
          <input name="id" type="hidden" value={customer.id} />
          <input name="updatedAt" type="hidden" value={customer.updated_at} />
        </>
      )}
      {state.message && (
        <div
          className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
          role="alert"
        >
          {state.message}
        </div>
      )}
      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <InputField
            autoComplete="name"
            defaultValue={customer?.name}
            errors={state.fieldErrors?.name}
            label="Customer name"
            name="name"
            placeholder="Full customer name"
            required
          />
        </div>
        <InputField
          defaultValue={customer?.facebook_name ?? ""}
          errors={state.fieldErrors?.facebookName}
          label="Facebook / CS name"
          name="facebookName"
          placeholder="Customer's Facebook display name"
        />
        <InputField
          autoComplete="tel"
          defaultValue={customer?.phone ?? ""}
          errors={state.fieldErrors?.phone}
          label="Phone"
          maxLength={40}
          name="phone"
          placeholder="+63 900 000 0000"
          type="tel"
        />
        <div className="sm:col-span-2">
          <TextareaField
            autoComplete="street-address"
            defaultValue={customer?.address ?? ""}
            errors={state.fieldErrors?.address}
            label="Address"
            name="address"
            placeholder="Customer address"
            rows={3}
          />
        </div>
        <div className="sm:col-span-2">
          <TextareaField
            defaultValue={customer?.notes ?? ""}
            errors={state.fieldErrors?.notes}
            label="Notes"
            name="notes"
            placeholder="Preferences, sizing, or other relevant notes"
            rows={5}
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t border-border pt-6">
        <FormSubmitButton>
          {customer ? "Save changes" : "Add customer"}
        </FormSubmitButton>
        <Link
          className="inline-flex h-11 items-center rounded-xl border border-border px-5 text-sm font-semibold text-ink hover:border-gold"
          href={customer ? "/customers/" + customer.id : "/customers"}
        >
          Cancel
        </Link>
      </div>
    </form>
  );
}
