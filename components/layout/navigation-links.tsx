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
                ? "bg-white/10 text-white shadow-sm"
                : "text-white/62 hover:bg-white/5 hover:text-white")
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
                  ? "bg-gold text-white"
                  : "border border-white/12 text-white/55")
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
