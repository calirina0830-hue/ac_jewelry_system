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
  try {
    const { data: accountStatus } = await supabase
      .from("profiles")
      .select("is_active")
      .eq("id", user.id)
      .maybeSingle();

    if (accountStatus && (accountStatus as { is_active?: boolean }).is_active === false) {
      redirectToSignOut("disabled");
    }
  } catch {
    // If is_active check fails, proceed with active session
  }

  return user;
});

export const getCurrentProfile = cache(async () => {
  const user = await requireUser();
  const supabase = await createClient();
  const { data } = await supabase
    .from("profiles")
    .select("id, full_name, role, avatar_url")
    .eq("id", user.id)
    .maybeSingle();

  if (data) {
    return {
      ...data,
      username:
        (data as { username?: string | null }).username ??
        (user.email ? user.email.split("@")[0] : null),
    };
  }

  // Graceful fallback from Supabase user session
  return {
    id: user.id,
    full_name:
      (typeof user.user_metadata?.full_name === "string" && user.user_metadata.full_name) ||
      (user.email ? user.email.split("@")[0] : "User"),
    role: "admin" as ProfileRole,
    username: user.email ? user.email.split("@")[0] : null,
    avatar_url: null,
  };
});

export async function authorizeRoles(roles: readonly ProfileRole[]) {
  const user = await requireUser();
  const profile = await getCurrentProfile();

  if (!profile) {
    return null;
  }

  // Developer, owner, and admin hold operational capabilities
  if (
    profile.role === "owner" ||
    profile.role === "developer" ||
    profile.role === "admin" ||
    roles.includes(profile.role)
  ) {
    return { user, profile };
  }

  return null;
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
