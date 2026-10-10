import { NextResponse, type NextRequest } from "next/server";

import { requireUser } from "@/lib/auth";
import { PAYMENT_EVIDENCE_BUCKET } from "@/lib/constants/payments";
import { isSafePaymentEvidencePath } from "@/lib/storage/payment-evidence";
import { createClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  await requireUser();
  const path = request.nextUrl.searchParams.get("path");
  if (!path || !isSafePaymentEvidencePath(path)) {
    return NextResponse.json({ error: "Invalid evidence path." }, { status: 400 });
  }

  const supabase = await createClient();
  const { data: attachment } = await supabase
    .from("reservation_payment_evidence")
    .select("id")
    .eq("storage_path", path)
    .maybeSingle();
  const { data: legacyPayment } = attachment
    ? { data: null }
    : await supabase
        .from("reservation_payments")
        .select("id")
        .eq("evidence_path", path)
        .maybeSingle();
  if (!attachment && !legacyPayment) {
    return NextResponse.json({ error: "Evidence not found." }, { status: 404 });
  }

  const { data, error } = await supabase.storage
    .from(PAYMENT_EVIDENCE_BUCKET)
    .download(path);
  if (error || !data) {
    return NextResponse.json({ error: "Evidence not found." }, { status: 404 });
  }

  return new NextResponse(data, {
    headers: {
      "Cache-Control": "private, max-age=300",
      "Content-Type": data.type || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
