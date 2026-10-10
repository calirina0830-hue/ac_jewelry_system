export default function StockLoading() {
  return (
    <div className="mx-auto max-w-[1500px] animate-pulse px-5 py-10 sm:px-8 lg:px-10">
      <div className="h-3 w-32 rounded bg-border" />
      <div className="mt-4 h-10 w-64 rounded-xl bg-border" />
      <div className="mt-8 h-20 rounded-2xl bg-white" />
      <div className="mt-6 h-[500px] rounded-2xl bg-white" />
    </div>
  );
}
