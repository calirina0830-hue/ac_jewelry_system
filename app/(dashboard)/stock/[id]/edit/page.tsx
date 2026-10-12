import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { StockForm } from "@/components/stock/stock-form";
import { PageHeader } from "@/components/ui/page-header";
import { getCurrentProfile, roleCanWrite, roleIsAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { getStockImageUrl } from "@/lib/storage/stock-images";
import { stockIdSchema } from "@/lib/validation/stock";

export const metadata: Metadata = { title: "Edit stock item" };

export default async function EditStockItemPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const parsedId = stockIdSchema.safeParse(id);

  if (!parsedId.success) {
    notFound();
  }

  const profile = await getCurrentProfile();

  if (!roleCanWrite(profile?.role)) {
    redirect("/stock/" + id + "?error=not-authorized");
  }

  const supabase = await createClient();
  const { data: item } = await supabase
    .from("stock_items")
    .select("*")
    .eq("id", parsedId.data)
    .maybeSingle();

  if (!item) {
    notFound();
  }

  if (item.archived_at && !roleIsAdmin(profile?.role)) {
    redirect("/stock/" + id + "?error=not-authorized");
  }

  return (
    <div className="mx-auto max-w-5xl px-5 py-8 sm:px-8 lg:px-10 lg:py-10">
      <PageHeader
        description="Update catalog details or the jewelry image."
        eyebrow="Stock management"
        title="Edit stock item"
      />
      <section className="mt-7 rounded-3xl border border-border bg-white p-6 shadow-card sm:p-8">
        <StockForm imageUrl={getStockImageUrl(item.image_path)} item={item} />
      </section>
    </div>
  );
}
