import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { archiveStockItem, restoreStockItem } from "@/actions/stock";
import { StockImage } from "@/components/stock/stock-image";
import { StockStatus } from "@/components/stock/stock-status";
import { ConfirmAction } from "@/components/ui/confirm-action";
import { PageHeader } from "@/components/ui/page-header";
import { PageNotice } from "@/components/ui/page-notice";
import { getCurrentProfile, roleCanWrite, roleIsAdmin } from "@/lib/auth";
import { formatDate } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { getStockImageUrl } from "@/lib/storage/stock-images";
import { stockIdSchema } from "@/lib/validation/stock";

export const metadata: Metadata = { title: "Stock item details" };

export default async function StockItemDetailsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ message?: string; error?: string }>;
}) {
  const { id } = await params;
  const notices = await searchParams;
  const parsedId = stockIdSchema.safeParse(id);

  if (!parsedId.success) {
    notFound();
  }

  const profile = await getCurrentProfile();
  const canWrite = roleCanWrite(profile?.role);
  const isAdmin = roleIsAdmin(profile?.role);
  const supabase = await createClient();
  const { data: item } = await supabase
    .from("stock_items")
    .select("*")
    .eq("id", parsedId.data)
    .maybeSingle();

  if (!item) {
    notFound();
  }

  return (
    <div className="mx-auto max-w-6xl px-5 py-8 sm:px-8 lg:px-10 lg:py-10">
      <PageHeader
        description={"SKU " + item.sku + " · " + item.category}
        eyebrow="Stock item"
        title={item.name}
      >
        <Link
          className="inline-flex h-11 items-center rounded-xl border border-border bg-white px-5 text-sm font-semibold text-ink hover:border-gold"
          href="/stock"
        >
          Back to stock
        </Link>
        {canWrite && (!item.archived_at || isAdmin) && (
          <Link
            className="inline-flex h-11 items-center rounded-xl bg-gold px-5 text-sm font-bold text-white hover:bg-gold-dark"
            href={"/stock/" + item.id + "/edit"}
          >
            Edit item
          </Link>
        )}
      </PageHeader>
      <PageNotice error={notices.error} message={notices.message} />

      <div className="mt-7 grid gap-6 lg:grid-cols-[minmax(300px,0.75fr)_1.25fr_280px]">
        <section className="overflow-hidden rounded-3xl border border-border bg-white p-4 shadow-card">
          <StockImage
            alt={item.name}
            size="large"
            url={getStockImageUrl(item.image_path)}
          />
        </section>

        <section className="rounded-3xl border border-border bg-white p-6 shadow-card sm:p-8">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-gold-dark">
            Catalog information
          </p>
          <dl className="mt-6 grid gap-7 sm:grid-cols-2">
            <InfoItem label="SKU">{item.sku}</InfoItem>
            <InfoItem label="Category">{item.category}</InfoItem>
            <div className="border-t border-border pt-7 sm:col-span-2">
              <InfoItem label="Description">
                <span className="whitespace-pre-wrap">
                  {item.description ?? "No description recorded."}
                </span>
              </InfoItem>
            </div>
          </dl>
        </section>

        <aside className="h-fit rounded-3xl border border-border bg-white p-6 shadow-card">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-muted">
            Inventory status
          </p>
          <div className="mt-5">
            <StockStatus
              active={item.is_active}
              archived={Boolean(item.archived_at)}
            />
          </div>
          <dl className="mt-6 space-y-5">
            <div>
              <dt className="text-xs text-muted">Date added</dt>
              <dd className="mt-1 text-sm font-semibold text-ink">
                {formatDate(item.created_at)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Last updated</dt>
              <dd className="mt-1 text-sm font-semibold text-ink">
                {formatDate(item.updated_at)}
              </dd>
            </div>
          </dl>
          {isAdmin && (
            <div className="mt-6 border-t border-border pt-5">
              {item.archived_at ? (
                <ConfirmAction
                  action={restoreStockItem.bind(null, item.id)}
                  confirmation={"Restore " + item.name + "?"}
                  variant="neutral"
                >
                  Restore item
                </ConfirmAction>
              ) : (
                <ConfirmAction
                  action={archiveStockItem.bind(null, item.id)}
                  confirmation={
                    "Archive " +
                    item.name +
                    "? The item can be restored later."
                  }
                >
                  Archive item
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
      <dt className="text-xs font-bold uppercase tracking-[0.15em] text-muted">
        {label}
      </dt>
      <dd className="mt-2 text-sm leading-7 text-ink">{children}</dd>
    </div>
  );
}
