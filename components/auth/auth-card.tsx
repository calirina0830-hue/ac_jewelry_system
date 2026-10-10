import type { ReactNode } from "react";

import { BrandMark } from "@/components/brand-mark";
import { BUSINESS } from "@/lib/constants/business";

type AuthCardProps = {
  eyebrow: string;
  title: string;
  description: string;
  children: ReactNode;
  footer?: ReactNode;
};

export function AuthCard({
  eyebrow,
  title,
  description,
  children,
  footer,
}: AuthCardProps) {
  return (
    <main className="grid min-h-screen lg:grid-cols-[minmax(0,1fr)_minmax(520px,0.8fr)]">
      <section className="relative hidden overflow-hidden bg-ink px-12 py-10 text-white lg:flex lg:flex-col">
        <div className="auth-glow" aria-hidden="true" />
        <BrandMark light />
        <div className="relative z-10 my-auto max-w-xl">
          <p className="mb-6 text-xs font-semibold uppercase tracking-[0.34em] text-gold-light">
            Private client management
          </p>
          <h2 className="font-serif text-5xl leading-[1.08] xl:text-6xl">
            Every detail,
            <br />
            beautifully managed.
          </h2>
          <p className="mt-7 max-w-md text-base leading-7 text-white/60">
            A secure workspace designed for the considered service and precise
            record-keeping behind {BUSINESS.name}.
          </p>
        </div>
        <p className="relative z-10 text-xs tracking-wider text-white/35">
          {BUSINESS.name.toUpperCase()} · {BUSINESS.systemLabel.toUpperCase()}
        </p>
      </section>

      <section className="flex min-h-screen items-center justify-center bg-canvas px-5 py-10 sm:px-10">
        <div className="w-full max-w-md">
          <div className="mb-10 lg:hidden">
            <BrandMark />
          </div>
          <p className="text-xs font-bold uppercase tracking-[0.24em] text-gold-dark">
            {eyebrow}
          </p>
          <h1 className="mt-3 font-serif text-4xl text-ink">{title}</h1>
          <p className="mt-3 leading-7 text-muted">{description}</p>
          <div className="mt-8">{children}</div>
          {footer && (
            <div className="mt-7 border-t border-border pt-6 text-sm text-muted">
              {footer}
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
