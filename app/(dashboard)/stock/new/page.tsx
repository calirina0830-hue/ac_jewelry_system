import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { StockForm } from "@/components/stock/stock-form";
import { PageHeader } from "@/components/ui/page-header";
import { getCurrentProfile, roleCanWrite } from "@/lib/auth";

export const metadata: Metadata = { title: "Add stock item" };

export default async function NewStockItemPage() {
  const profile = await getCurrentProfile();

  if (!roleCanWrite(profile?.role)) {
    redirect("/stock?error=not-authorized");
  }

  return (
    <div className="mx-auto max-w-5xl px-5 py-8 sm:px-8 lg:px-10 lg:py-10">
      <PageHeader
        description="Add a jewelry item and its catalog image."
        eyebrow="Stock management"
        title="Add stock item"
      />
      <section className="mt-7 rounded-3xl border border-border bg-white p-6 shadow-card sm:p-8">
        <StockForm />
      </section>
    </div>
  );
}
