import { cache } from "react";
import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import type { ProfileRole } from "@/types/database";

// Server Components cannot write cookies, so terminating a session from a
// guard must go through the /auth/signout Route Handler. That handler clears
// the Supabase cookies for real and lands on /login exactly once. Redirecting
// to /login directly would leave stale cookies in place and let the proxy
// bounce the browser between /login and /dashboard forever.
function redirectToSignOut(reason: "expired" | "disabled" | "profile"): never {
  redirect(`/auth/signout?reason=${reason}`);
}

export const requireUser = cache(async () => {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  // A stale or revoked session (e.g. after a backend user change) fails this
  // server-side check even when its cookies still pass local JWT verification.
  if (error || !user) {
    redirectToSignOut("expired");
  }

  // Disabled accounts are signed out on their next request.
  const { data: accountStatus } = await supabase
    .from("profiles")
    .select("is_active")
    .eq("id", user.id)
    .maybeSingle();

  if (accountStatus && !accountStatus.is_active) {
    redirectToSignOut("disabled");
  }

  return user;
});

export const getCurrentProfile = cache(async () => {
  const user = await requireUser();
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("profiles")
    .select("id, username, full_name, role, avatar_url")
    .eq("id", user.id)
    .single();

  // The auth session is valid but the profile row is definitively gone
  // (deleted or hidden by a backend user/profile change): the session is
  // inconsistent and must be cleared once via /auth/signout. Transient lookup
  // failures keep the previous graceful-degradation path instead of signing
  // users out unnecessarily.
  if ((!error && !data) || error?.code === "PGRST116") {
    redirectToSignOut("profile");
  }

  if (error || !data) {
    return null;
  }

  return data;
});

export async function authorizeRoles(roles: readonly ProfileRole[]) {
  const user = await requireUser();
  const profile = await getCurrentProfile();

  // Developer and owner hold every operational capability; they additionally
  // pass the dedicated account-management checks.
  if (
    !profile ||
    (profile.role !== "owner" &&
      profile.role !== "developer" &&
      !roles.includes(profile.role))
  ) {
    return null;
  }

  return { user, profile };
}

// Account Management access: developer and owner only. Admin, staff, and
// viewer are operational roles and never pass this check.
export async function authorizeOwner() {
  return authorizeRoles(["owner", "developer"]);
}

export function roleCanWrite(role: ProfileRole | undefined): boolean {
  return (
    role === "admin" ||
    role === "developer" ||
    role === "owner" ||
    role === "staff"
  );
}
