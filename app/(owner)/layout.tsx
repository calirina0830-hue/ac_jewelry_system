import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";

import { logoutAction } from "@/actions/auth";
import { BrandMark } from "@/components/brand-mark";
import { authorizeOwner } from "@/lib/auth";
import { BUSINESS } from "@/lib/constants/business";

export const metadata: Metadata = {
  title: "Account Management",
  robots: { index: false, follow: false },
};

// Dedicated protected shell for system owners. This route group sits outside
// the dashboard layout: no sidebar, no navigation links back into the app
// chrome beyond an explicit exit action. Non-owners are redirected before any
// content renders.
export default async function OwnerLayout({
  children,
}: {
  children: ReactNode;
}) {
  // requireUser redirects anonymous visitors to /login; non-owners are sent
  // back to the dashboard with an authorization error.
  const authorization = await authorizeOwner();

  if (!authorization) {
    redirect("/dashboard?error=not-authorized");
  }

  const { user, profile } = authorization;
  const displayName =
    profile.username ?? profile.full_name ?? user.email ?? "System account";

  return (
    <div className="flex min-h-screen flex-col bg-canvas">
      <header className="bg-ink px-5 py-4 sm:px-8" data-print-hide>
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <BrandMark light />
            <span className="hidden h-9 w-px bg-white/15 sm:block" aria-hidden="true" />
            <div className="leading-tight">
              <p className="text-[0.6rem] font-bold uppercase tracking-[0.22em] text-gold-light">
                System Area
              </p>
              <p className="font-serif text-lg text-white">
                Account Management
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden text-right text-xs text-white/55 sm:block">
              Signed in as{" "}
              <span className="font-semibold text-white">{displayName}</span>
              <span className="block text-[0.65rem] uppercase tracking-wider text-gold-light">
                {BUSINESS.name} ·{" "}
                {profile.role === "developer" ? "Developer" : "Owner"}
              </span>
            </span>
            <Link
              className="rounded-xl border border-white/15 px-4 py-2 text-sm font-semibold text-white/80 transition hover:border-white/30 hover:bg-white/5 hover:text-white"
              href="/dashboard"
            >
              Back to App
            </Link>
            <form action={logoutAction}>
              <button
                className="rounded-xl border border-white/15 px-4 py-2 text-sm font-semibold text-white/80 transition hover:border-white/30 hover:bg-white/5 hover:text-white"
                type="submit"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-5 py-8 sm:px-8">
        {children}
      </main>
      <footer
        className="border-t border-border px-5 py-5 text-center text-xs text-muted sm:px-8"
        data-print-hide
      >
        {BUSINESS.name} · Restricted to the developer and owner. All access is
        recorded.
      </footer>
    </div>
  );
}
