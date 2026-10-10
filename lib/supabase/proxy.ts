import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { getSupabaseConfig } from "@/lib/supabase/config";
import type { Database } from "@/types/database";

const PUBLIC_ROUTES = [
  "/login",
  "/forgot-password",
  "/auth",
] as const;

function isPublicRoute(pathname: string): boolean {
  return PUBLIC_ROUTES.some(
    (route) => pathname === route || pathname.startsWith(route + "/"),
  );
}

// getClaims verifies JWTs locally, so a stale or revoked session can still
// look authenticated here. Before bouncing a visitor from /login to the
// dashboard, confirm the profile row still exists and is active; otherwise
// clear the session right away (cookie writes work in the proxy) and let the
// login page render with an explanatory message.
async function hasValidProfile(
  supabase: ReturnType<typeof createServerClient<Database>>,
  userId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from("profiles")
    .select("is_active")
    .eq("id", userId)
    .maybeSingle();

  return Boolean(data?.is_active);
}

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });
  const config = getSupabaseConfig();

  const supabase = createServerClient<Database>(
    config.url,
    config.publishableKey,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet, headers) {
          cookiesToSet.forEach(({ name, value }) => {
            request.cookies.set(name, value);
          });

          supabaseResponse = NextResponse.next({ request });

          cookiesToSet.forEach(({ name, value, options }) => {
            supabaseResponse.cookies.set(name, value, options);
          });

          Object.entries(headers).forEach(([key, value]) => {
            supabaseResponse.headers.set(key, value);
          });
        },
      },
    },
  );

  // Keep this directly after client creation. getClaims verifies the JWT and
  // refreshes expired credentials when required.
  const { data } = await supabase.auth.getClaims();
  const isAuthenticated = Boolean(data?.claims);

  if (!isAuthenticated && !isPublicRoute(request.nextUrl.pathname)) {
    const loginUrl = request.nextUrl.clone();
    const requestedPath = request.nextUrl.pathname + request.nextUrl.search;
    loginUrl.pathname = "/login";
    loginUrl.search = "";
    loginUrl.searchParams.set("next", requestedPath);
    return NextResponse.redirect(loginUrl);
  }

  if (isAuthenticated && request.nextUrl.pathname === "/login") {
    const userId = data?.claims.sub;
    const profileValid =
      typeof userId === "string" && (await hasValidProfile(supabase, userId));

    if (profileValid) {
      const dashboardUrl = request.nextUrl.clone();
      dashboardUrl.pathname = "/dashboard";
      dashboardUrl.search = "";
      return NextResponse.redirect(dashboardUrl);
    }

    // Authenticated claims but a missing/inactive profile: the session is
    // inconsistent. Clear it here where cookie writes succeed, then send the
    // browser to /login once with an explanatory message. Because the cookies
    // are gone, the follow-up request passes straight through to the login
    // page instead of re-entering this branch, so no loop is possible.
    await supabase.auth.signOut();
    const loginUrl = request.nextUrl.clone();
    loginUrl.search = "";
    loginUrl.searchParams.set("error", "session-expired");

    if (loginUrl.toString() === request.nextUrl.toString()) {
      return supabaseResponse;
    }

    return NextResponse.redirect(loginUrl);
  }

  return supabaseResponse;
}
