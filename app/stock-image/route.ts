import { NextResponse, type NextRequest } from "next/server";

import { requireUser } from "@/lib/auth";
import { STOCK_IMAGE_BUCKET } from "@/lib/constants/stock";
import { isSafeStockImagePath } from "@/lib/storage/stock-images";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  await requireUser();
  const path = request.nextUrl.searchParams.get("path");

  if (!path || !isSafeStockImagePath(path)) {
    console.error("Stock image request rejected", {
      hasPath: Boolean(path),
      pathLength: path?.length ?? 0,
    });
    return NextResponse.json({ error: "Invalid image path." }, { status: 400 });
  }

  const supabase = await createClient();
  const { data, error } = await supabase.storage
    .from(STOCK_IMAGE_BUCKET)
    .download(path);

  if (error || !data) {
    console.error("Stock image download failed", {
      path,
      message: error?.message ?? "empty response body",
    });
    return NextResponse.json({ error: "Image not found." }, { status: 404 });
  }

  return new NextResponse(data, {
    headers: {
      "Cache-Control": "private, max-age=300",
      "Content-Type": data.type || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
