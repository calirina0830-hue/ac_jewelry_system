"use client";

import { useLayoutEffect, useSyncExternalStore, type ReactNode } from "react";

import {
  THEME_CHANGE_EVENT,
  THEME_STORAGE_KEY,
  type ThemePreference,
} from "@/lib/theme";

const DARK_QUERY = "(prefers-color-scheme: dark)";

function readPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // Storage can be unavailable (private mode, blocked site data).
  }
  return "system";
}

function applyTheme(preference: ThemePreference = readPreference()) {
  const isDark =
    preference === "dark" ||
    (preference === "system" && window.matchMedia(DARK_QUERY).matches);
  document.documentElement.setAttribute("data-theme", isDark ? "dark" : "light");
}

function setPreference(preference: ThemePreference) {
  try {
    if (preference === "system") {
      localStorage.removeItem(THEME_STORAGE_KEY);
    } else {
      localStorage.setItem(THEME_STORAGE_KEY, preference);
    }
  } catch {
    // Still apply the theme for this page view.
  }
  applyTheme(preference);
  window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
}

function subscribe(onChange: () => void) {
  window.addEventListener(THEME_CHANGE_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(THEME_CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/**
 * Mounted once in the root layout. The inline script in app/layout.tsx sets
 * the initial theme before paint; this keeps it correct afterwards: it
 * re-applies the attribute after React's dev Strict Mode remount clears it,
 * follows the OS setting live while the preference is "system", syncs other
 * open tabs, and prints in light mode so invoices come out on white paper.
 */
export function ThemeSync() {
  useLayoutEffect(() => {
    applyTheme();

    const media = window.matchMedia(DARK_QUERY);
    const syncFromPreference = () => applyTheme();
    const printLight = () =>
      document.documentElement.setAttribute("data-theme", "light");

    media.addEventListener("change", syncFromPreference);
    window.addEventListener("storage", syncFromPreference);
    window.addEventListener("beforeprint", printLight);
    window.addEventListener("afterprint", syncFromPreference);
    return () => {
      media.removeEventListener("change", syncFromPreference);
      window.removeEventListener("storage", syncFromPreference);
      window.removeEventListener("beforeprint", printLight);
      window.removeEventListener("afterprint", syncFromPreference);
    };
  }, []);

  return null;
}

const OPTIONS: Array<{ value: ThemePreference; label: string; icon: ReactNode }> = [
  {
    value: "light",
    label: "Light",
    icon: (
      <>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
      </>
    ),
  },
  {
    value: "dark",
    label: "Dark",
    icon: <path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11Z" />,
  },
  {
    value: "system",
    label: "System",
    icon: (
      <>
        <rect x="3" y="4" width="18" height="12" rx="2" />
        <path d="M8 20h8M12 16v4" />
      </>
    ),
  },
];

/**
 * Light / Dark / System switch. "onDark" styles it for the always-dark
 * navigation panels; "surface" for regular page backgrounds.
 */
export function ThemeToggle({
  tone = "surface",
  className = "",
}: {
  tone?: "onDark" | "surface";
  className?: string;
}) {
  // The server cannot know the stored preference, so nothing is highlighted
  // in the server HTML; the client snapshot fills it in right after hydration.
  const current = useSyncExternalStore(subscribe, readPreference, () => null);

  const frame =
    tone === "onDark"
      ? "border-white/10 bg-white/5"
      : "border-border bg-white shadow-sm";
  const idle =
    tone === "onDark"
      ? "text-white/60 hover:bg-white/5 hover:text-white"
      : "text-muted hover:bg-canvas hover:text-ink";
  const active =
    tone === "onDark" ? "bg-white/15 text-white" : "bg-gold-soft text-gold-dark";

  return (
    <div
      aria-label="Color theme"
      className={"grid grid-cols-3 gap-1 rounded-xl border p-1 " + frame + " " + className}
      role="group"
    >
      {OPTIONS.map((option) => {
        const isActive = current === option.value;
        return (
          <button
            aria-pressed={isActive}
            className={
              "flex min-h-9 items-center justify-center gap-1.5 rounded-lg px-2 text-xs font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-gold " +
              (isActive ? active : idle)
            }
            key={option.value}
            onClick={() => setPreference(option.value)}
            title={option.label + " theme"}
            type="button"
          >
            <svg
              aria-hidden="true"
              className="size-4 shrink-0"
              fill="none"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="1.8"
              viewBox="0 0 24 24"
            >
              {option.icon}
            </svg>
            <span>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
