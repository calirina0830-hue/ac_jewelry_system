import { NextResponse, type NextRequest } from "next/server";

import { createClient } from "@/lib/supabase/server";

// Route Handlers can write cookies, so this endpoint is the only place where
// a stale or revoked Supabase session can be cleared for Server Component
// flows (cookies().set() throws in Server Components and the error is
// swallowed). Guards redirect here once; this handler clears the session and
// sends the browser to /login exactly once, so no redirect loop is possible.
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  await supabase.auth.signOut();

  const reason = request.nextUrl.searchParams.get("reason");
  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set(
    "error",
    reason === "disabled" ? "disabled" : "session-expired",
  );

  return NextResponse.redirect(loginUrl);
}
