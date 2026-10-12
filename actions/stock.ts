"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { logActivity } from "@/lib/activity";
import { authorizeRoles, roleIsAdmin } from "@/lib/auth";
import { STOCK_IMAGE_BUCKET } from "@/lib/constants/stock";
import { resolveStockQuantity } from "@/lib/stock/quantity";
import { createClient } from "@/lib/supabase/server";
import { validateStockImage } from "@/lib/storage/stock-images";
import { getFieldErrors } from "@/lib/validation/form-errors";
import { stockFormSchema, stockIdSchema } from "@/lib/validation/stock";
import type { FormActionState } from "@/types/forms";

const WRITE_ROLES = ["admin", "staff", "owner", "developer"] as const;
type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

function unauthorizedState(): FormActionState {
  return {
    status: "error",
    message: "You do not have permission to perform this action.",
  };
}

function getImageFile(formData: FormData): File | null {
  const value = formData.get("image");
  return value instanceof File && value.size > 0 ? value : null;
}

async function uploadImage(
  supabase: SupabaseServerClient,
  userId: string,
  file: File,
): Promise<
  | { success: true; path: string }
  | { success: false; message: string }
> {
  const validation = await validateStockImage(file);

  if (!validation.success) {
    return validation;
  }

  const path =
    userId + "/" + randomUUID() + "." + validation.image.extension;
  const { error } = await supabase.storage
    .from(STOCK_IMAGE_BUCKET)
    .upload(path, validation.image.body, {
      cacheControl: "31536000",
      contentType: validation.image.contentType,
      upsert: false,
    });

  if (error) {
    console.error("Stock image upload failed", error.message);
    return {
      success: false,
      message: "The image could not be uploaded. Please try again.",
    };
  }

  return { success: true, path };
}

async function removeImage(
  supabase: SupabaseServerClient,
  path: string,
): Promise<void> {
  const { error } = await supabase.storage
    .from(STOCK_IMAGE_BUCKET)
    .remove([path]);

  if (error) {
    console.error("Stock image cleanup failed", error.message);
  }
}

export async function createStockItem(
  _previousState: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const authorization = await authorizeRoles(WRITE_ROLES);

  if (!authorization) {
    return unauthorizedState();
  }

  const parsed = stockFormSchema.safeParse({
    sku: formData.get("sku"),
    name: formData.get("name"),
    description: formData.get("description"),
    category: formData.get("category"),
    quantity: resolveStockQuantity(),
    isActive: "true",
  });

  if (!parsed.success) {
    return {
      status: "error",
      message: "Please correct the highlighted fields.",
      fieldErrors: getFieldErrors(parsed.error),
    };
  }

  const supabase = await createClient();
  const imageFile = getImageFile(formData);
  let imagePath: string | null = null;

  if (imageFile) {
    const upload = await uploadImage(
      supabase,
      authorization.user.id,
      imageFile,
    );

    if (!upload.success) {
      return {
        status: "error",
        message: "Please correct the selected image.",
        fieldErrors: { image: [upload.message] },
      };
    }

    imagePath = upload.path;
  }

  const { data, error } = await supabase
    .from("stock_items")
    .insert({
      sku: parsed.data.sku,
      name: parsed.data.name,
      description: parsed.data.description,
      category: parsed.data.category,
      price: 0,
      quantity: parsed.data.quantity,
      is_active: parsed.data.isActive,
      image_path: imagePath,
      created_by: authorization.user.id,
    })
    .select("id")
    .single();

  if (error) {
    if (imagePath) {
      await removeImage(supabase, imagePath);
    }

    console.error("Stock item creation failed", error.code);
    return {
      status: "error",
      message:
        error.code === "23505"
          ? "That SKU is already in use."
          : "The stock item could not be created. Please try again.",
      fieldErrors:
        error.code === "23505" ? { sku: ["SKU must be unique."] } : undefined,
    };
  }

  revalidatePath("/stock");
  revalidatePath("/dashboard");
  await logActivity(supabase, {
    action: "stock_created",
    entityType: "stock",
    entityId: data.id,
    description:
      "Created stock item " + parsed.data.sku + " (" + parsed.data.name + ").",
    metadata: { sku: parsed.data.sku, name: parsed.data.name },
  });
  redirect("/stock/" + data.id + "?message=created");
}

export async function updateStockItem(
  _previousState: FormActionState,
  formData: FormData,
): Promise<FormActionState> {
  const authorization = await authorizeRoles(WRITE_ROLES);

  if (!authorization) {
    return unauthorizedState();
  }

  const parsedId = stockIdSchema.safeParse(formData.get("id"));

  if (!parsedId.success) {
    return { status: "error", message: "Invalid stock item identifier." };
  }

  const supabase = await createClient();
  const { data: existing } = await supabase
    .from("stock_items")
    .select("image_path, archived_at, quantity, is_active")
    .eq("id", parsedId.data)
    .maybeSingle();

  if (!existing) {
    return { status: "error", message: "Stock item not found." };
  }

  if (existing.archived_at && !roleIsAdmin(authorization.profile.role)) {
    return {
      status: "error",
      message: "Archived stock can only be changed by an administrator.",
    };
  }

  const parsed = stockFormSchema.safeParse({
    id: parsedId.data,
    updatedAt: formData.get("updatedAt"),
    sku: formData.get("sku"),
    name: formData.get("name"),
    description: formData.get("description"),
    category: formData.get("category"),
    quantity: resolveStockQuantity(existing.quantity),
    isActive: existing.is_active ? "true" : "false",
  });

  if (!parsed.success || !parsed.data.id || !parsed.data.updatedAt) {
    return {
      status: "error",
      message: "Please correct the highlighted fields.",
      fieldErrors: parsed.success ? undefined : getFieldErrors(parsed.error),
    };
  }

  const imageFile = getImageFile(formData);
  const shouldRemoveImage = formData.get("removeImage") === "true";
  let nextImagePath = shouldRemoveImage ? null : existing.image_path;
  let uploadedPath: string | null = null;

  if (imageFile) {
    const upload = await uploadImage(
      supabase,
      authorization.user.id,
      imageFile,
    );

    if (!upload.success) {
      return {
        status: "error",
        message: "Please correct the selected image.",
        fieldErrors: { image: [upload.message] },
      };
    }

    uploadedPath = upload.path;
    nextImagePath = upload.path;
  }

  const { id, updatedAt, isActive, ...values } = parsed.data;
  const { data: updated, error } = await supabase
    .from("stock_items")
    .update({
      ...values,
      is_active: isActive,
      image_path: nextImagePath,
    })
    .eq("id", id)
    .eq("updated_at", updatedAt)
    .select("id")
    .maybeSingle();

  if (error) {
    if (uploadedPath) {
      await removeImage(supabase, uploadedPath);
    }

    console.error("Stock item update failed", error.code);
    return {
      status: "error",
      message:
        error.code === "23505"
          ? "That SKU is already in use."
          : "The stock item could not be updated. Please try again.",
      fieldErrors:
        error.code === "23505" ? { sku: ["SKU must be unique."] } : undefined,
    };
  }

  if (!updated) {
    if (uploadedPath) {
      await removeImage(supabase, uploadedPath);
    }

    return {
      status: "error",
      message:
        "This stock item was changed in another session. Reload before saving again.",
    };
  }

  if (
    existing.image_path &&
    existing.image_path !== nextImagePath
  ) {
    await removeImage(supabase, existing.image_path);
  }

  revalidatePath("/stock");
  revalidatePath("/stock/" + id);
  revalidatePath("/dashboard");
  await logActivity(supabase, {
    action: "stock_edited",
    entityType: "stock",
    entityId: id,
    description:
      "Edited stock item " + parsed.data.sku + " (" + parsed.data.name + ").",
    metadata: { sku: parsed.data.sku, name: parsed.data.name },
  });
  redirect("/stock/" + id + "?message=updated");
}

export async function archiveStockItem(id: string): Promise<void> {
  const authorization = await authorizeRoles(["admin"]);
  const parsedId = stockIdSchema.safeParse(id);

  if (!authorization || !parsedId.success) {
    redirect("/stock?error=not-authorized");
  }

  const supabase = await createClient();
  const { data: archived, error } = await supabase
    .from("stock_items")
    .update({
      archived_at: new Date().toISOString(),
      is_active: false,
    })
    .eq("id", parsedId.data)
    .is("archived_at", null)
    .select("id")
    .maybeSingle();

  if (error || !archived) {
    console.error("Stock archive failed", error?.code ?? "no-row-updated");
    redirect("/stock?error=archive-failed");
  }

  await logActivity(supabase, {
    action: "stock_archived",
    entityType: "stock",
    entityId: parsedId.data,
    description: "Archived stock item.",
  });
  revalidatePath("/stock");
  revalidatePath("/stock/" + parsedId.data);
  revalidatePath("/dashboard");
  redirect("/stock?message=archived");
}

export async function restoreStockItem(id: string): Promise<void> {
  const authorization = await authorizeRoles(["admin"]);
  const parsedId = stockIdSchema.safeParse(id);

  if (!authorization || !parsedId.success) {
    redirect("/stock?error=not-authorized");
  }

  const supabase = await createClient();
  const { data: restored, error } = await supabase
    .from("stock_items")
    .update({ archived_at: null, is_active: true })
    .eq("id", parsedId.data)
    .not("archived_at", "is", null)
    .select("id")
    .maybeSingle();

  if (error || !restored) {
    console.error("Stock restore failed", error?.code ?? "no-row-updated");
    redirect("/stock?error=restore-failed");
  }

  await logActivity(supabase, {
    action: "stock_restored",
    entityType: "stock",
    entityId: parsedId.data,
    description: "Restored stock item from archive.",
  });
  revalidatePath("/stock");
  revalidatePath("/stock/" + parsedId.data);
  revalidatePath("/dashboard");
  redirect("/stock?message=restored");
}
