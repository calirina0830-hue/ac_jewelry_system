"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { logActivity } from "@/lib/activity";
import { authorizeRoles } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  createCustomerSchema,
  customerIdSchema,
  updateCustomerSchema,
} from "@/lib/validation/customers";
import { getFieldErrors } from "@/lib/validation/form-errors";
import type { FormActionState } from "@/types/forms";

const WRITE_ROLES = ["admin", "staff"] as const;

function getTextField(formData: FormData, name: string): string | undefined {
  const value = formData.get(name);
  return typeof value === "string" ? value : undefined;
}

function getCustomerFields(formData: FormData) {
  return {
    name: getTextField(formData, "name"),
    facebookName: getTextField(formData, "facebookName"),
    phone: getTextField(formData, "phone"),
    address: getTextField(formData, "address"),
    notes: getTextField(formData, "notes"),
  };
}

function unauthorizedState(): FormActionState {
  return {
    status: "error",
    message: "You do not have permission to perform this action.",
  };
}

export async function createCustomer(
  _previousState: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const authorization = await authorizeRoles(WRITE_ROLES);

  if (!authorization) {
    return unauthorizedState();
  }

  const parsed = createCustomerSchema.safeParse(getCustomerFields(formData));

  if (!parsed.success) {
    return {
      status: "error",
      message: "Please correct the highlighted fields.",
      fieldErrors: getFieldErrors(parsed.error),
    };
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("customers")
    .insert({
      name: parsed.data.name,
      facebook_name: parsed.data.facebookName,
      phone: parsed.data.phone,
      address: parsed.data.address,
      notes: parsed.data.notes,
      created_by: authorization.user.id,
    })
    .select("id")
    .single();

  if (error) {
    console.error("Customer creation failed", {
      code: error.code,
      message: error.message,
      details: error.details,
      hint: error.hint,
    });
    return {
      status: "error",
      message: "The customer could not be created. Please try again.",
    };
  }

  revalidatePath("/customers");
  revalidatePath("/dashboard");
  await logActivity(supabase, {
    action: "customer_created",
    entityType: "customer",
    entityId: data.id,
    description: "Created customer " + parsed.data.name + ".",
    metadata: { name: parsed.data.name },
  });
  redirect("/customers/" + data.id + "?message=created");
}

export async function updateCustomer(
  _previousState: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const authorization = await authorizeRoles(WRITE_ROLES);

  if (!authorization) {
    return unauthorizedState();
  }

  const parsed = updateCustomerSchema.safeParse({
    id: getTextField(formData, "id"),
    updatedAt: getTextField(formData, "updatedAt"),
    ...getCustomerFields(formData),
  });

  if (!parsed.success) {
    const fieldErrors = getFieldErrors(parsed.error);
    const hiddenFieldError =
      fieldErrors.id?.[0] ?? fieldErrors.updatedAt?.[0];

    return {
      status: "error",
      message: hiddenFieldError ?? "Please correct the highlighted fields.",
      fieldErrors,
    };
  }

  const supabase = await createClient();
  const { data: existing } = await supabase
    .from("customers")
    .select("archived_at")
    .eq("id", parsed.data.id)
    .maybeSingle();

  if (!existing) {
    return { status: "error", message: "Customer not found." };
  }

  if (existing.archived_at && authorization.profile.role !== "admin") {
    return {
      status: "error",
      message: "Archived customers can only be changed by an administrator.",
    };
  }

  const { id, updatedAt, facebookName, ...updates } = parsed.data;
  const { data: updated, error } = await supabase
    .from("customers")
    .update({ ...updates, facebook_name: facebookName })
    .eq("id", id)
    .eq("updated_at", updatedAt)
    .select("id")
    .maybeSingle();

  if (error) {
    console.error("Customer update failed", error.code);
    return {
      status: "error",
      message: "The customer could not be updated. Please try again.",
    };
  }

  if (!updated) {
    return {
      status: "error",
      message:
        "This customer was changed in another session. Reload before saving again.",
    };
  }

  revalidatePath("/customers");
  revalidatePath("/customers/" + id);
  revalidatePath("/dashboard");
  await logActivity(supabase, {
    action: "customer_edited",
    entityType: "customer",
    entityId: id,
    description: "Edited customer " + parsed.data.name + ".",
    metadata: { name: parsed.data.name },
  });
  redirect("/customers/" + id + "?message=updated");
}

export async function archiveCustomer(id: string): Promise<void> {
  const authorization = await authorizeRoles(["admin"]);
  const parsedId = customerIdSchema.safeParse(id);

  if (!authorization || !parsedId.success) {
    redirect("/customers?error=not-authorized");
  }

  const supabase = await createClient();
  const { data: archived, error } = await supabase
    .from("customers")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", parsedId.data)
    .is("archived_at", null)
    .select("id")
    .maybeSingle();

  if (error || !archived) {
    console.error("Customer archive failed", error?.code ?? "no-row-updated");
    redirect("/customers?error=archive-failed");
  }

  await logActivity(supabase, {
    action: "customer_archived",
    entityType: "customer",
    entityId: parsedId.data,
    description: "Archived customer.",
  });
  revalidatePath("/customers");
  revalidatePath("/customers/" + parsedId.data);
  revalidatePath("/dashboard");
  redirect("/customers?message=archived");
}

export async function restoreCustomer(id: string): Promise<void> {
  const authorization = await authorizeRoles(["admin"]);
  const parsedId = customerIdSchema.safeParse(id);

  if (!authorization || !parsedId.success) {
    redirect("/customers?error=not-authorized");
  }

  const supabase = await createClient();
  const { data: restored, error } = await supabase
    .from("customers")
    .update({ archived_at: null })
    .eq("id", parsedId.data)
    .not("archived_at", "is", null)
    .select("id")
    .maybeSingle();

  if (error || !restored) {
    console.error("Customer restore failed", error?.code ?? "no-row-updated");
    redirect("/customers?error=restore-failed");
  }

  await logActivity(supabase, {
    action: "customer_restored",
    entityType: "customer",
    entityId: parsedId.data,
    description: "Restored customer from archive.",
  });
  revalidatePath("/customers");
  revalidatePath("/customers/" + parsedId.data);
  revalidatePath("/dashboard");
  redirect("/customers?message=restored");
}
