import Link from "next/link";

export default function NotFound() {
  return (
    <main className="grid min-h-screen place-items-center bg-canvas px-5">
      <div className="max-w-md text-center">
        <p className="font-serif text-7xl text-gold">404</p>
        <h1 className="mt-4 font-serif text-3xl text-ink">Page not found</h1>
        <p className="mt-3 leading-7 text-muted">
          The page you requested does not exist or is no longer available.
        </p>
        <Link
          className="mt-7 inline-flex rounded-xl bg-ink px-5 py-3 text-sm font-bold text-white"
          href="/dashboard"
        >
          Return to dashboard
        </Link>
      </div>
    </main>
  );
}
