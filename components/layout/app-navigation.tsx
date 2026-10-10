import { logoutAction } from "@/actions/auth";
import { BrandMark } from "@/components/brand-mark";
import { NavigationLinks } from "@/components/layout/navigation-links";

type AppNavigationProps = {
  userName: string;
  userEmail: string;
  role: string;
};

function UserSummary({
  userName,
  userEmail,
  role,
}: AppNavigationProps) {
  const initial = userName.charAt(0).toUpperCase() || "B";

  return (
    <div className="flex min-w-0 items-center gap-3">
      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-gold-soft font-serif text-lg text-gold-dark">
        {initial}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-semibold text-white">
          {userName}
        </span>
        <span className="block truncate text-xs text-white/45">
          {role} · {userEmail}
        </span>
      </span>
    </div>
  );
}

export function DesktopSidebar(props: AppNavigationProps) {
  return (
    <aside
      className="fixed inset-y-0 left-0 z-30 hidden w-72 flex-col bg-ink px-5 py-7 lg:flex"
      data-print-hide
    >
      <div className="px-3">
        <BrandMark light />
      </div>
      <nav className="mt-12 space-y-1" aria-label="Primary navigation">
        <NavigationLinks />
      </nav>
      <div className="mt-auto border-t border-white/10 pt-5">
        <UserSummary {...props} />
        <form action={logoutAction}>
          <button
            className="mt-4 w-full rounded-xl border border-white/10 px-4 py-2.5 text-sm font-semibold text-white/70 transition hover:border-white/20 hover:bg-white/5 hover:text-white"
            type="submit"
          >
            Sign out
          </button>
        </form>
      </div>
    </aside>
  );
}

export function MobileHeader(props: AppNavigationProps) {
  return (
    <header
      className="sticky top-0 z-40 border-b border-border bg-canvas/95 px-5 py-4 backdrop-blur lg:hidden"
      data-print-hide
    >
      <div className="flex items-center justify-between">
        <BrandMark />
        <details className="group relative">
          <summary className="grid size-11 cursor-pointer list-none place-items-center rounded-xl border border-border bg-white text-ink marker:hidden">
            <span className="sr-only">Open navigation</span>
            <span className="space-y-1.5" aria-hidden="true">
              <span className="block h-px w-5 bg-current" />
              <span className="block h-px w-5 bg-current" />
              <span className="block h-px w-5 bg-current" />
            </span>
          </summary>
          <div className="absolute right-0 mt-3 w-72 rounded-2xl border border-border bg-ink p-4 shadow-2xl">
            <UserSummary {...props} />
            <nav className="mt-4 border-t border-white/10 pt-4">
              <NavigationLinks />
            </nav>
            <form action={logoutAction}>
              <button
                className="mt-3 w-full rounded-xl border border-white/10 px-4 py-2.5 text-sm font-semibold text-white/70"
                type="submit"
              >
                Sign out
              </button>
            </form>
          </div>
        </details>
      </div>
    </header>
  );
}
