import type { Metadata } from "next";
import Link from "next/link";

import { ReservationStatus } from "@/components/reservations/reservation-status";
import { getCurrentProfile, requireUser, roleCanWrite, roleIsAdmin } from "@/lib/auth";
import { formatCurrency, formatDate } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  const user = await requireUser();
  const profile = await getCurrentProfile();
  const supabase = await createClient();
  const [
    metricsResult,
    customersResult,
    reservationsResult,
    categoryMetricsResult,
    importMetricsResult,
    paymentMetricsResult,
  ] = await Promise.all([
    supabase.rpc("get_dashboard_metrics"),
    supabase
      .from("customers")
      .select("id, name, facebook_name, phone, created_at")
      .is("archived_at", null)
      .order("created_at", { ascending: false })
      .limit(5),
    supabase
      .from("reservation_list")
      .select(
        "id, reservation_no, customer_name, customer_facebook_name, total, balance, status, reserved_at, delivered_at",
      )
      .is("archived_at", null)
      .order("reserved_at", { ascending: false })
      .limit(5),
    supabase.rpc("get_reservation_category_metrics"),
    supabase.rpc("get_live_import_metrics"),
    supabase.rpc("get_payment_metrics"),
  ]);
  const metrics = metricsResult.data?.[0] ?? {
    total_customers: 0,
    active_stock_items: 0,
    total_units: 0,
    low_stock_items: 0,
    active_reservations: 0,
    reserved_count: 0,
    paid_count: 0,
    delivered_count: 0,
    cancelled_count: 0,
    reserved_value: 0,
    paid_value: 0,
    outstanding_balance: 0,
  };
  const hasError = Boolean(
    metricsResult.error ||
      customersResult.error ||
      reservationsResult.error ||
      categoryMetricsResult.error ||
      importMetricsResult.error ||
      paymentMetricsResult.error,
  );
  const importMetrics = importMetricsResult.data?.[0] ?? {
    imported_reservations_today: 0,
    imported_items_today: 0,
    imported_reserved_value: 0,
    new_customers_from_imports: 0,
  };
  const paymentMetrics = paymentMetricsResult.data?.[0] ?? {
    paid_amount: 0,
    payments_awaiting_evidence: 0,
  };
  const name =
    profile?.full_name ||
    (typeof user.user_metadata.full_name === "string"
      ? user.user_metadata.full_name
      : null) ||
    "there";

  return (
    <div className="mx-auto max-w-7xl px-5 py-8 sm:px-8 lg:px-10 lg:py-10">
      <header className="flex flex-col gap-5 border-b border-border pb-8 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.24em] text-gold-dark">
            Jewelry operations
          </p>
          <h1 className="mt-3 font-serif text-4xl text-ink sm:text-5xl">
            Welcome, {name}.
          </h1>
          <p className="mt-3 max-w-2xl leading-7 text-muted">
            Monitor reservation workflow, customer activity, and jewelry inventory.
          </p>
        </div>
        <span className="w-fit rounded-full border border-border bg-white px-3 py-1.5 text-xs font-bold capitalize text-ink">
          {profile?.role ?? "viewer"} access
        </span>
      </header>

      {hasError && (
        <div
          className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm leading-6 text-amber-900"
          role="alert"
        >
          Dashboard metrics could not be fully loaded. Confirm all migrations,
          including Phase 4, have been applied to Supabase.
        </div>
      )}

      <section className="mt-8">
        <p className="text-xs font-bold uppercase tracking-[0.2em] text-gold-dark">
          Reservation monitoring
        </p>
        <h2 className="mt-1 font-serif text-3xl text-ink">Current workflow</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatusMetricCard href="/reservations?status=reserved" label="Reserved" tone="reserved" value={metrics.reserved_count} />
          <StatusMetricCard href="/reservations?status=paid" label="Paid" tone="paid" value={metrics.paid_count} />
          <StatusMetricCard href="/reservations?status=delivered" label="Delivered" tone="delivered" value={metrics.delivered_count} />
          <StatusMetricCard href="/reservations?status=cancelled" label="Cancelled" tone="cancelled" value={metrics.cancelled_count} />
        </div>
      </section>

      <section className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard detail="Active reservations awaiting full payment" href="/reservations?status=reserved" label="Reserved value" mark="R" value={formatCurrency(Number(metrics.reserved_value))} />
        <MetricCard detail="Paid and delivered reservation value" href="/reservations?status=paid" label="Paid value" mark="P" value={formatCurrency(Number(metrics.paid_value))} />
        <MetricCard accent={Number(metrics.outstanding_balance) > 0} detail="Balance remaining on reservations" href="/reservations?status=reserved&sort=balance&direction=desc" label="Outstanding balance" mark="B" value={formatCurrency(Number(metrics.outstanding_balance))} />
        <MetricCard detail="Non-archived client records" href="/customers" label="Total customers" mark="C" value={metrics.total_customers} />
        <MetricCard detail="Available catalog records" href="/stock?status=active" label="Active stock items" mark="A" value={metrics.active_stock_items} />
        <MetricCard detail="Sum of all non-voided partial and full payments" href="/reservations?status=all" label="Payments received" mark="₱" value={formatCurrency(Number(paymentMetrics.paid_amount))} />
        <MetricCard accent={paymentMetrics.payments_awaiting_evidence > 0} detail="Non-voided payments without an evidence attachment" href="/reservations?status=all" label="Payments awaiting evidence" mark="E" value={paymentMetrics.payments_awaiting_evidence} />
      </section>

      {roleCanWrite(profile?.role) && (
        <section className="mt-8">
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-gold-dark">
            Live Selling imports
          </p>
          <h2 className="mt-1 font-serif text-3xl text-ink">Import activity</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard detail="Confirmed today" href="/reservations?status=reserved" label="Imported reservations" mark="R" value={importMetrics.imported_reservations_today} />
            <MetricCard detail="Reservation item rows confirmed today" href={roleIsAdmin(profile?.role) ? "/reservations/import/history" : "/reservations/import"} label="Imported items" mark="I" value={importMetrics.imported_items_today} />
            <MetricCard detail="Reserved value imported today" href="/reservations?status=reserved" label="Imported reserved value" mark="V" value={formatCurrency(Number(importMetrics.imported_reserved_value))} />
            <MetricCard detail="Created across confirmed imports" href="/customers" label="New import customers" mark="C" value={importMetrics.new_customers_from_imports} />
          </div>
        </section>
      )}

      <section className="mt-6 grid gap-6 xl:grid-cols-3">
        <ActivityPanel title="Recent reservations" eyebrow="Order activity" href="/reservations" linkLabel="View all">
          {reservationsResult.data?.length ? (
            <div className="divide-y divide-border">
              {reservationsResult.data.map((reservation) => (
                <Link className="flex items-center justify-between gap-4 px-6 py-4 transition hover:bg-canvas" href={"/reservations/" + reservation.id} key={reservation.id}>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold text-ink">{reservation.customer_name}</span>
                    <span className="mt-1 block truncate text-xs text-muted">
                      {reservation.customer_facebook_name
                        ? "Facebook / CS: " + reservation.customer_facebook_name
                        : reservation.reservation_no + " · " + formatDate(reservation.reserved_at)}
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    <ReservationStatus
                      delivered={Boolean(reservation.delivered_at)}
                      status={reservation.status}
                    />
                    <span className="mt-1 block text-[10px] font-bold text-ink">{formatCurrency(Number(reservation.total))}</span>
                  </span>
                </Link>
              ))}
            </div>
          ) : (
            <DashboardEmpty message="No active reservations have been created yet." />
          )}
        </ActivityPanel>

        <ActivityPanel title="Recent customers" eyebrow="Client activity" href="/customers" linkLabel="View all">
          {customersResult.data?.length ? (
            <div className="divide-y divide-border">
              {customersResult.data.map((customer) => (
                <Link className="flex items-center justify-between gap-4 px-6 py-4 transition hover:bg-canvas" href={"/customers/" + customer.id} key={customer.id}>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold text-ink">{customer.name}</span>
                    <span className="mt-1 block truncate text-xs text-muted">
                      {customer.facebook_name ? "Facebook / CS: " + customer.facebook_name : customer.phone ?? "No Facebook / CS name"}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs text-muted">{formatDate(customer.created_at)}</span>
                </Link>
              ))}
            </div>
          ) : (
            <DashboardEmpty message="No active customers have been added yet." />
          )}
        </ActivityPanel>

      </section>

      <section className="mt-6 overflow-hidden rounded-3xl border border-border bg-white shadow-card">
        <div className="border-b border-border px-6 py-5">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-gold-dark">Category monitoring</p>
          <h2 className="mt-1 font-serif text-2xl text-ink">Jewelry activity by category</h2>
          <p className="mt-1 text-xs text-muted">Based on category snapshots stored with each reservation item.</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] border-collapse text-left">
            <thead className="bg-canvas text-[11px] uppercase tracking-[0.14em] text-muted">
              <tr>
                <th className="px-6 py-4 font-bold">Category</th>
                <th className="px-5 py-4 font-bold">Reserved qty.</th>
                <th className="px-5 py-4 font-bold">Paid qty.</th>
                <th className="px-5 py-4 font-bold">Delivered qty.</th>
                <th className="px-5 py-4 font-bold">Cancelled qty.</th>
                <th className="px-5 py-4 font-bold">Total involved</th>
                <th className="px-6 py-4 text-right font-bold">Committed line value</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {categoryMetricsResult.data?.map((category) => (
                <tr key={category.category}>
                  <td className="px-6 py-4 font-semibold text-ink">{category.category}</td>
                  <td className="px-5 py-4 text-sm text-ink">{category.reserved_quantity}</td>
                  <td className="px-5 py-4 text-sm text-ink">{category.paid_quantity}</td>
                  <td className="px-5 py-4 text-sm text-ink">{category.delivered_quantity}</td>
                  <td className="px-5 py-4 text-sm text-muted">{category.cancelled_quantity}</td>
                  <td className="px-5 py-4 text-sm font-bold text-ink">{category.total_quantity}</td>
                  <td className="whitespace-nowrap px-6 py-4 text-right text-sm font-bold text-ink">{formatCurrency(Number(category.committed_value))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function ActivityPanel({
  title,
  eyebrow,
  href,
  linkLabel,
  children,
}: {
  title: string;
  eyebrow: string;
  href: string;
  linkLabel: string;
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-3xl border border-border bg-white shadow-card">
      <div className="flex items-center justify-between border-b border-border px-6 py-5">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-gold-dark">{eyebrow}</p>
          <h2 className="mt-1 font-serif text-2xl text-ink">{title}</h2>
        </div>
        <Link className="text-sm font-bold text-gold-dark hover:underline" href={href}>
          {linkLabel}
        </Link>
      </div>
      {children}
    </div>
  );
}

function MetricCard({
  label,
  value,
  detail,
  href,
  mark,
  accent = false,
}: {
  label: string;
  value: number | string;
  detail: string;
  href: string;
  mark: string;
  accent?: boolean;
}) {
  return (
    <Link
      className="group rounded-2xl border border-border bg-white p-5 shadow-card transition hover:-translate-y-0.5 hover:border-gold/40"
      href={href}
    >
      <div className="flex items-start justify-between">
        <p className="text-xs font-bold uppercase tracking-[0.14em] text-muted">{label}</p>
        <span
          className={
            "grid size-8 place-items-center rounded-lg text-xs font-black " +
            (accent ? "bg-amber-100 text-amber-800" : "bg-gold-soft text-gold-dark")
          }
        >
          {mark}
        </span>
      </div>
      <p className="mt-5 font-serif text-4xl text-ink">{value}</p>
      <p className="mt-1 text-xs text-muted">{detail}</p>
    </Link>
  );
}

function StatusMetricCard({
  label,
  value,
  href,
  tone,
}: {
  label: string;
  value: number;
  href: string;
  tone: "reserved" | "paid" | "delivered" | "cancelled";
}) {
  const colors = {
    reserved: "border-amber-200 bg-amber-50/60 text-amber-800",
    paid: "border-emerald-200 bg-emerald-50/60 text-emerald-700",
    delivered: "border-sky-200 bg-sky-50/60 text-sky-700",
    cancelled: "border-red-200 bg-red-50/60 text-red-700",
  }[tone];

  return (
    <Link
      className={"rounded-2xl border p-5 transition hover:-translate-y-0.5 " + colors}
      href={href}
    >
      <p className="text-xs font-bold uppercase tracking-[0.16em]">{label}</p>
      <p className="mt-4 font-serif text-4xl text-ink">{value}</p>
      <p className="mt-1 text-xs">View {label.toLowerCase()} reservations</p>
    </Link>
  );
}

function DashboardEmpty({ message }: { message: string }) {
  return <div className="px-6 py-12 text-center text-sm text-muted">{message}</div>;
}
