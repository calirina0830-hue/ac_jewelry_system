import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { CustomerForm } from "@/components/customers/customer-form";
import { PageHeader } from "@/components/ui/page-header";
import { getCurrentProfile, roleCanWrite } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { customerIdSchema } from "@/lib/validation/customers";

export const metadata: Metadata = { title: "Edit customer" };

export default async function EditCustomerPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const parsedId = customerIdSchema.safeParse(id);

  if (!parsedId.success) {
    notFound();
  }

  const profile = await getCurrentProfile();

  if (!roleCanWrite(profile?.role)) {
    redirect("/customers/" + id + "?error=not-authorized");
  }

  const supabase = await createClient();
  const { data: customer } = await supabase
    .from("customers")
    .select("*")
    .eq("id", parsedId.data)
    .maybeSingle();

  if (!customer) {
    notFound();
  }

  if (customer.archived_at && profile?.role !== "admin") {
    redirect("/customers/" + id + "?error=not-authorized");
  }

  return (
    <div className="mx-auto max-w-4xl px-5 py-8 sm:px-8 lg:px-10 lg:py-10">
      <PageHeader
        description="Keep customer contact and service information current."
        eyebrow="Customer management"
        title="Edit customer"
      />
      <section className="mt-7 rounded-3xl border border-border bg-white p-6 shadow-card sm:p-8">
        <CustomerForm customer={customer} />
      </section>
    </div>
  );
}
