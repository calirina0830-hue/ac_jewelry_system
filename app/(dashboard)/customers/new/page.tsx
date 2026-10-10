import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { CustomerForm } from "@/components/customers/customer-form";
import { PageHeader } from "@/components/ui/page-header";
import { getCurrentProfile, roleCanWrite } from "@/lib/auth";

export const metadata: Metadata = { title: "Add customer" };

export default async function NewCustomerPage() {
  const profile = await getCurrentProfile();

  if (!roleCanWrite(profile?.role)) {
    redirect("/customers?error=not-authorized");
  }

  return (
    <div className="mx-auto max-w-4xl px-5 py-8 sm:px-8 lg:px-10 lg:py-10">
      <PageHeader
        description="Add contact details and private service notes for a customer."
        eyebrow="Customer management"
        title="Add customer"
      />
      <section className="mt-7 rounded-3xl border border-border bg-white p-6 shadow-card sm:p-8">
        <CustomerForm />
      </section>
    </div>
  );
}
