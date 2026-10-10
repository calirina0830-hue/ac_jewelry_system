import type { ReactNode } from "react";

import {
  DesktopSidebar,
  MobileHeader,
} from "@/components/layout/app-navigation";
import { getCurrentProfile, requireUser } from "@/lib/auth";
import { BUSINESS } from "@/lib/constants/business";

export default async function DashboardLayout({
  children,
}: {
  children: ReactNode;
}) {
  const user = await requireUser();
  const profile = await getCurrentProfile();
  const userName =
    profile?.full_name ||
    (typeof user.user_metadata.full_name === "string"
      ? user.user_metadata.full_name
      : null) ||
    user.email?.split("@")[0] ||
    BUSINESS.name + " user";
  const navigationProps = {
    userName,
    userEmail: user.email ?? "Authenticated account",
    role: profile?.role ?? "viewer",
  };

  return (
    <div className="min-h-screen bg-canvas">
      <DesktopSidebar {...navigationProps} />
      <MobileHeader {...navigationProps} />
      <main className="lg:pl-72">{children}</main>
    </div>
  );
}
