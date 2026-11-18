"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ACTIVE_LINKS = [
  { href: "/reservations", label: "Reservations", mark: "R" },
  { href: "/customers", label: "Customers", mark: "C" },
] as const;

export function NavigationLinks() {
  const pathname = usePathname();

  return (
    <>
      {ACTIVE_LINKS.map((item) => {
        const isActive =
          pathname === item.href || pathname.startsWith(item.href + "/");

        return (
          <Link
            aria-current={isActive ? "page" : undefined}
            className={
              "flex items-center gap-3 rounded-xl px-4 py-3 text-sm font-semibold transition " +
              (isActive
                ? "bg-white/20 text-white shadow-sm dark:bg-white/10"
                : "text-white/85 hover:bg-white/10 hover:text-white dark:text-white/62 dark:hover:bg-white/5")
            }
            href={item.href}
            key={item.href}
            onClick={(event) => {
              event.currentTarget.closest("details")?.removeAttribute("open");
            }}
          >
            <span
              className={
                "grid size-7 place-items-center rounded-lg text-[11px] font-black " +
                (isActive
                  ? "bg-white text-[#9c1f5f] dark:bg-gold dark:text-white"
                  : "border border-white/30 text-white/80 dark:border-white/12 dark:text-white/55")
              }
              aria-hidden="true"
            >
              {item.mark}
            </span>
            {item.label}
          </Link>
        );
      })}
    </>
  );
}
