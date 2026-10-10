import Link from "next/link";
import type { ReactNode } from "react";

type PageHeaderProps = {
  eyebrow: string;
  title: string;
  description: string;
  actionHref?: string;
  actionLabel?: string;
  children?: ReactNode;
};

export function PageHeader({
  eyebrow,
  title,
  description,
  actionHref,
  actionLabel,
  children,
}: PageHeaderProps) {
  return (
    <header className="flex flex-col gap-5 border-b border-border pb-7 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <p className="text-xs font-bold uppercase tracking-[0.22em] text-gold-dark">
          {eyebrow}
        </p>
        <h1 className="mt-2 font-serif text-4xl text-ink">{title}</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">
          {description}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {children}
        {actionHref && actionLabel && (
          <Link
            className="inline-flex h-11 items-center justify-center rounded-xl bg-gold px-5 text-sm font-bold text-white shadow-[0_10px_25px_rgba(139,100,46,0.16)] transition hover:bg-gold-dark"
            href={actionHref}
          >
            {actionLabel}
          </Link>
        )}
      </div>
    </header>
  );
}
