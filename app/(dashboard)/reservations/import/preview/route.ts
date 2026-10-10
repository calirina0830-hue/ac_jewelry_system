import { NextResponse } from "next/server";

import { authorizeRoles } from "@/lib/auth";
import { LIVE_IMPORT_MAX_BYTES } from "@/lib/import/live-orders";
import { prepareLiveOrderPreview } from "@/lib/import/server";
import { createClient } from "@/lib/supabase/server";

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
    return NextResponse.json({ preview });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "The import file could not be previewed.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
