"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

// Give up on the bar if a navigation never finishes (e.g. it was aborted).
const MAX_PENDING_MS = 20_000;

/**
 * Thin progress bar at the top of the screen that appears the moment an
 * in-app link is clicked and disappears when the new view has arrived.
 *
 * Most navigations on the reservations page only change the query string
 * (tabs, paging, opening a customer), where Next.js shows no loading.tsx
 * fallback, so without this the page looks frozen while the server works.
 */
export function NavigationProgress() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const currentUrl = pathname + "?" + searchParams.toString();
  // The URL the user was on when they clicked. The bar shows only while we
  // are still on that URL, so it hides itself as soon as navigation lands.
  const [pendingFrom, setPendingFrom] = useState<string | null>(null);
  const pending = pendingFrom !== null && pendingFrom === currentUrl;

  // Navigation landed: forget the old URL so that returning to it later does
  // not bring the bar back while nothing is loading.
  if (pendingFrom !== null && pendingFrom !== currentUrl) {
    setPendingFrom(null);
  }

  useEffect(() => {
    function onClick(event: MouseEvent) {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      const anchor = (event.target as Element | null)?.closest?.("a");
      if (
        !anchor ||
        !anchor.href ||
        anchor.hasAttribute("download") ||
        (anchor.target && anchor.target !== "_self")
      ) {
        return;
      }
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      // Route handlers (PDF downloads) are not page navigations.
      if (url.pathname.endsWith("/pdf")) return;
      const nextUrl = url.pathname + "?" + url.searchParams.toString();
      const here =
        window.location.pathname +
        "?" +
        new URLSearchParams(window.location.search).toString();
      if (nextUrl === here) return;
      setPendingFrom(here);
    }

    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  useEffect(() => {
    if (!pending) return;
    const timer = window.setTimeout(() => setPendingFrom(null), MAX_PENDING_MS);
    return () => window.clearTimeout(timer);
  }, [pending]);

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-x-0 top-0 z-[200] h-1"
      data-print-hide
    >
      {pending && <div className="nav-progress h-full" />}
    </div>
  );
}
