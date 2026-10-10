import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import {
  archiveCustomer,
  restoreCustomer,
} from "@/actions/customers";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { PageHeader } from "@/components/ui/page-header";
import { PageNotice } from "@/components/ui/page-notice";
import { getCurrentProfile, roleCanWrite } from "@/lib/auth";
import { formatDate } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { customerIdSchema } from "@/lib/validation/customers";

export const metadata: Metadata = { title: "Customer details" };

export default async function CustomerDetailsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ message?: string; error?: string }>;
}) {
  const { id } = await params;
  const notices = await searchParams;
  const parsedId = customerIdSchema.safeParse(id);

  if (!parsedId.success) {
    notFound();
  }

  const profile = await getCurrentProfile();
  const canWrite = roleCanWrite(profile?.role);
  const isAdmin = profile?.role === "admin";
  const supabase = await createClient();
  const { data: customer } = await supabase
    .from("customers")
    .select(
      "id, name, facebook_name, phone, address, notes, created_at, updated_at, archived_at",
    )
    .eq("id", parsedId.data)
    .maybeSingle();

  if (!customer) {
    notFound();
  }

  return (
    <div className="mx-auto max-w-5xl px-5 py-8 sm:px-8 lg:px-10 lg:py-10">
      <PageHeader
        description="Customer contact information and service notes."
        eyebrow="Customer profile"
        title={customer.name}
      >
        <Link
          className="inline-flex h-11 items-center rounded-xl border border-border bg-white px-5 text-sm font-semibold text-ink hover:border-gold"
          href="/customers"
        >
          Back to customers
        </Link>
        {canWrite && (!customer.archived_at || isAdmin) && (
          <Link
            className="inline-flex h-11 items-center rounded-xl bg-gold px-5 text-sm font-bold text-white hover:bg-gold-dark"
            href={"/customers/" + customer.id + "/edit"}
          >
            Edit customer
          </Link>
        )}
      </PageHeader>
      <PageNotice error={notices.error} message={notices.message} />

      <div className="mt-7 grid gap-6 lg:grid-cols-[1fr_300px]">
        <section className="rounded-3xl border border-border bg-white p-6 shadow-card sm:p-8">
          <div className="grid gap-7 sm:grid-cols-2">
            <InfoItem label="Facebook / CS name">
              {customer.facebook_name ?? "Not provided"}
            </InfoItem>
            <InfoItem label="Phone">
              {customer.phone ? (
                <a className="text-gold-dark hover:underline" href={"tel:" + customer.phone}>
                  {customer.phone}
                </a>
              ) : (
                "Not provided"
              )}
            </InfoItem>
            <div className="sm:col-span-2">
              <InfoItem label="Address">
                <span className="whitespace-pre-wrap">
                  {customer.address ?? "Not provided"}
                </span>
              </InfoItem>
            </div>
            <div className="border-t border-border pt-7 sm:col-span-2">
              <InfoItem label="Private notes">
                <span className="whitespace-pre-wrap">
                  {customer.notes ?? "No notes recorded."}
                </span>
              </InfoItem>
            </div>
          </div>
        </section>

        <aside className="h-fit rounded-3xl border border-border bg-white p-6 shadow-card">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-muted">
            Record information
          </p>
          <dl className="mt-5 space-y-5">
            <div>
              <dt className="text-xs text-muted">Status</dt>
              <dd className="mt-1">
                <span
                  className={
                    "rounded-full px-2.5 py-1 text-xs font-bold " +
                    (customer.archived_at
                      ? "bg-stone-100 text-stone-600"
                      : "bg-emerald-50 text-emerald-700")
                  }
                >
                  {customer.archived_at ? "Archived" : "Active"}
                </span>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Date added</dt>
              <dd className="mt-1 text-sm font-semibold text-ink">
                {formatDate(customer.created_at)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Last updated</dt>
              <dd className="mt-1 text-sm font-semibold text-ink">
                {formatDate(customer.updated_at)}
              </dd>
            </div>
          </dl>
          {isAdmin && (
            <div className="mt-6 border-t border-border pt-5">
              {customer.archived_at ? (
                <ConfirmAction
                  action={restoreCustomer.bind(null, customer.id)}
                  confirmation={"Restore " + customer.name + "?"}
                  variant="neutral"
                >
                  Restore customer
                </ConfirmAction>
              ) : (
                <ConfirmAction
                  action={archiveCustomer.bind(null, customer.id)}
                  confirmation={
                    "Archive " +
                    customer.name +
                    "? The record can be restored later."
                  }
                >
                  Archive customer
                </ConfirmAction>
              )}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function InfoItem({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="text-xs font-bold uppercase tracking-[0.15em] text-muted">
        {label}
      </p>
      <div className="mt-2 text-sm leading-7 text-ink">{children}</div>
    </div>
  );
}
