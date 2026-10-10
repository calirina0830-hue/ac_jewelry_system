import Link from "next/link";

export function EmptyState({
  title,
  description,
  actionHref,
  actionLabel,
}: {
  title: string;
  description: string;
  actionHref?: string;
  actionLabel?: string;
}) {
  return (
    <div className="px-6 py-16 text-center">
      <span className="mx-auto grid size-14 place-items-center rounded-2xl bg-gold-soft font-serif text-2xl text-gold-dark">
        ◇
      </span>
      <h2 className="mt-5 font-serif text-2xl text-ink">{title}</h2>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted">
        {description}
      </p>
      {actionHref && actionLabel && (
        <Link
          className="mt-6 inline-flex rounded-xl bg-gold px-5 py-3 text-sm font-bold text-white"
          href={actionHref}
        >
          {actionLabel}
        </Link>
      )}
    </div>
  );
}
