"use client";

import type { ReactNode } from "react";

export function ConfirmAction({
  action,
  confirmation,
  children,
  variant = "danger",
  appearance = "link",
}: {
  action: () => Promise<void>;
  confirmation: string;
  children: ReactNode;
  variant?: "danger" | "neutral";
  appearance?: "link" | "compact-neutral" | "compact-danger";
}) {
  const buttonClassName =
    appearance === "compact-neutral"
      ? "inline-flex h-9 items-center justify-center rounded-lg border border-border bg-white px-3 text-sm font-semibold text-ink transition hover:border-gold hover:bg-canvas"
      : appearance === "compact-danger"
        ? "inline-flex h-9 items-center justify-center rounded-lg px-3 text-sm font-semibold text-red-700 transition hover:bg-red-50"
        : "text-sm font-semibold hover:underline " +
          (variant === "danger" ? "text-red-700" : "text-gold-dark");

  return (
    <form
      action={action}
      onSubmit={(event) => {
        if (!window.confirm(confirmation)) {
          event.preventDefault();
        }
      }}
    >
      <button
        className={buttonClassName}
        type="submit"
      >
        {children}
      </button>
    </form>
  );
}
