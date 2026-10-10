"use client";

import { useEffect } from "react";

import { BUSINESS } from "@/lib/constants/business";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(BUSINESS.name + " page error", error);
  }, [error]);

  return (
    <main className="grid min-h-screen place-items-center bg-canvas px-5">
      <div className="max-w-md rounded-3xl border border-border bg-white p-8 text-center shadow-card">
        <p className="text-xs font-bold uppercase tracking-[0.22em] text-gold-dark">
          Something went wrong
        </p>
        <h1 className="mt-4 font-serif text-3xl text-ink">
          We could not load this page.
        </h1>
        <p className="mt-3 text-sm leading-6 text-muted">
          Your data has not been changed. Try loading the page again.
        </p>
        <button
          className="mt-7 rounded-xl bg-gold px-5 py-3 text-sm font-bold text-white transition hover:bg-gold-dark"
          onClick={reset}
          type="button"
        >
          Try again
        </button>
      </div>
    </main>
  );
}
