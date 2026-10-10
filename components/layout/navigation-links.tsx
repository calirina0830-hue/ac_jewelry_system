"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ACTIVE_LINKS = [
  { href: "/dashboard", label: "Dashboard", mark: "D" },
  { href: "/customers", label: "Customers", mark: "C" },
  { href: "/stock", label: "Stock", mark: "S" },
  { href: "/reservations", label: "Reservations", mark: "R" },
] as const;

const FUTURE_LINKS = ["Reports"] as const;

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
      <div className="my-3 border-t border-white/8" />
      {FUTURE_LINKS.map((item) => (
        <span
          aria-disabled="true"
          className="flex cursor-not-allowed items-center justify-between rounded-xl px-4 py-3 text-sm font-medium text-white/32"
          key={item}
          title="Available in a later phase"
        >
          <span className="flex items-center gap-3">
            <span className="size-2 rounded-full border border-current" aria-hidden="true" />
            {item}
          </span>
          <span className="text-[9px] font-bold uppercase tracking-wider">
            Soon
          </span>
        </span>
      ))}
    </>
  );
}
