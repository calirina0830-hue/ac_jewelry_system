import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";

import { logActivity } from "@/lib/activity";
import { authorizeRoles } from "@/lib/auth";
import { prepareLiveOrderPreview } from "@/lib/import/server";
import {
  LIVE_IMPORT_MAX_BYTES,
  toConfirmationRows,
} from "@/lib/import/live-orders";
import { createClient } from "@/lib/supabase/server";

// TEMPORARY diagnostics for the Confirm Import failure investigation.
// Logs only RPC error metadata and non-sensitive row context (item code /
// identity tokens the RPC already embeds in its messages). Never logs
// credentials, keys, cookies, or session data. Remove after root cause is
// verified against a live confirmation attempt.
function logConfirmationRpcError(
  error: {
    message?: string;
    code?: string;
    details?: string;
    hint?: string;
  },
  rowCount: number,
): void {
  const message = typeof error.message === "string" ? error.message : "";
  // RPC domain errors embed context after the first colon, e.g.
  // "item_not_found:1879" or "duplicate_reserved_item:<uuid>".
  const colonIndex = message.indexOf(":");
  const reason = colonIndex === -1 ? message : message.slice(0, colonIndex);
  const context = colonIndex === -1 ? null : message.slice(colonIndex + 1);

  console.error(
    JSON.stringify({
      scope: "confirm_live_order_import_rpc_failed",
      errorMessage: message,
      errorCode: error.code ?? null,
      errorDetails: error.details ?? null,
      errorHint: error.hint ?? null,
      failingReason: reason || null,
      failingItemCodeOrId: context,
      confirmationRowCount: rowCount,
    }),
  );
}

function friendlyImportError(message: string): string {
  if (message.includes("invalid_import_price")) {
    return "A row contains a price the database could not accept. Re-check the file and import again.";
  }
  if (message.includes("invalid_import_downpayment")) {
    return "A row contains a downpayment the database could not accept. Re-check the file and import again.";
  }
  if (message.includes("item_not_found") || message.includes("item_ambiguous")) {
    return "An item changed after preview and can no longer be matched safely.";
  }
  return "The import could not be confirmed. No records were created.";
}

export async function POST(request: Request) {
  const authorized = await authorizeRoles(["admin", "staff"]);
  if (!authorized) {
    return NextResponse.json({ error: "You are not allowed to import orders." }, { status: 403 });
  }

  try {
    const contentLength = Number(request.headers.get("content-length") ?? "0");
    if (contentLength > LIVE_IMPORT_MAX_BYTES + 64 * 1024) {
      return NextResponse.json(
        { error: "The import file must be 5 MB or smaller." },
        { status: 413 },
      );
    }
    const formData = await request.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Choose a CSV or XLSX file." }, { status: 400 });
    }

    const supabase = await createClient();
    const preview = await prepareLiveOrderPreview(supabase, file);

    if (preview.summary.invalidRows > 0) {
      return NextResponse.json(
        { error: "Resolve every invalid preview row before confirming the import." },
        { status: 422 },
      );
    }

    const { data, error } = await supabase.rpc("confirm_live_order_import", {
      p_original_file_name: preview.fileName,
      p_file_hash: preview.fileHash,
      p_default_live_batch: null,
      p_rows: toConfirmationRows(preview),
    });

    if (error) {
      logConfirmationRpcError(
        {
          message: error.message,
          code: error.code,
          details: error.details,
          hint: error.hint,
        },
        Array.isArray(preview.rows) ? preview.rows.length : 0,
      );
      return NextResponse.json(
        { error: friendlyImportError(error.message) },
        { status: 422 },
      );
    }

    revalidatePath("/dashboard");
    revalidatePath("/reservations");
    revalidatePath("/reservations/import");
    revalidatePath("/reservations/import/history");

    await logActivity(supabase, {
      action: "live_orders_imported",
      entityType: "import",
      entityId: data?.batchId ?? null,
      description:
        "Imported live orders from " +
        preview.fileName +
        " (" +
        (data?.reservationCount ?? 0) +
        " reservations).",
      metadata: {
        file_name: preview.fileName,
        reservation_count: data?.reservationCount ?? 0,
        item_count: data?.itemCount ?? 0,
        new_customer_count: data?.newCustomerCount ?? 0,
      },
    });

    return NextResponse.json({ result: data });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "The import could not be confirmed.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
