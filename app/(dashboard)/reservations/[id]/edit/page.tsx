import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { ReservationForm } from "@/components/reservations/reservation-form";
import { PageHeader } from "@/components/ui/page-header";
import { getCurrentProfile, roleCanWrite } from "@/lib/auth";
import { loadReservationEditData } from "@/lib/reservations/reservation-edit-data";
import { createClient } from "@/lib/supabase/server";
import { reservationIdSchema } from "@/lib/validation/reservations";

export const metadata: Metadata = { title: "Edit reservation" };

export default async function EditReservationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const parsedId = reservationIdSchema.safeParse(id);

  if (!parsedId.success) {
    notFound();
  }

  // The permission check and the reservation load at the same time. Nothing
  // is shown until the checks below pass.
  const supabase = await createClient();
  const [profile, data] = await Promise.all([
    getCurrentProfile(),
    loadReservationEditData(supabase, parsedId.data),
  ]);

  if (!roleCanWrite(profile?.role)) {
    redirect("/reservations?error=not-authorized");
  }

  if (data.status === "not-found") {
    notFound();
  }

  if (data.status === "not-editable") {
    redirect("/reservations?error=not-editable");
  }

  return (
    <div className="mx-auto max-w-[1400px] px-5 py-8 sm:px-8 lg:px-10 lg:py-10">
      <PageHeader
        description="Adjust the customer, jewelry items, discounts, downpayment, or notes."
        eyebrow="Order"
        title="Edit reservation"
      />
      {data.options.hasError && (
        <div
          className="mt-6 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
          role="alert"
        >
          Customer details could not be fully loaded. Reload before
          saving changes.
        </div>
      )}
      <section className="mt-7 rounded-3xl border border-border bg-white p-5 shadow-card sm:p-8">
        <ReservationForm
          customers={data.options.customers}
          initialValue={data.initialValue}
        />
      </section>
    </div>
  );
}
