export default function DashboardLoading() {
  return (
    <div className="mx-auto max-w-7xl animate-pulse px-5 py-10 sm:px-8 lg:px-10">
      <div className="h-3 w-40 rounded bg-border" />
      <div className="mt-5 h-12 w-80 max-w-full rounded-xl bg-border" />
      <div className="mt-4 h-5 w-full max-w-xl rounded bg-border/70" />
      <div className="mt-12 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((item) => (
          <div className="h-32 rounded-2xl bg-white" key={item} />
        ))}
      </div>
      <div className="mt-12 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3, 4, 5, 6].map((item) => (
          <div className="h-32 rounded-2xl bg-white" key={item} />
        ))}
      </div>
      <div className="mt-6 grid gap-6 xl:grid-cols-3">
        <div className="h-96 rounded-3xl bg-white" />
        <div className="h-96 rounded-3xl bg-white" />
        <div className="h-96 rounded-3xl bg-white" />
      </div>
      <div className="mt-6 h-96 rounded-3xl bg-white" />
    </div>
  );
}
