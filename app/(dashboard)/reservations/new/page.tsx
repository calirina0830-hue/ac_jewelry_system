import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { ReservationForm } from "@/components/reservations/reservation-form";
import { PageHeader } from "@/components/ui/page-header";
import { getCurrentProfile, roleCanWrite } from "@/lib/auth";
import { getReservationFormOptions } from "@/lib/reservations/form-options";

export const metadata: Metadata = { title: "Create reservation" };

export default async function NewReservationPage() {
  const profile = await getCurrentProfile();

  if (!roleCanWrite(profile?.role)) {
    redirect("/reservations?error=not-authorized");
  }

  const options = await getReservationFormOptions();

  return (
    <div className="mx-auto max-w-[1400px] px-5 py-8 sm:px-8 lg:px-10 lg:py-10">
      <PageHeader
        description="Select a customer and reserve one or more available jewelry pieces."
        eyebrow="Reservation management"
        title="Create reservation"
      />
      {options.hasError && (
        <div
          className="mt-6 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
          role="alert"
        >
          Customer or stock options could not be fully loaded. Confirm the Phase 3
          migration is applied before creating a reservation.
        </div>
      )}
      <section className="mt-7 rounded-3xl border border-border bg-white p-5 shadow-card sm:p-8">
        <ReservationForm
          customers={options.customers}
          stockItems={options.stockItems}
        />
      </section>
    </div>
  );
}
