import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import { reservationIdSchema } from "@/lib/validation/reservations";

export const metadata: Metadata = { title: "Reservation invoice" };

export default async function ReservationInvoiceRedirect({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const parsedId = reservationIdSchema.safeParse(id);
  if (!parsedId.success) notFound();

  const supabase = await createClient();
  const { data: reservation } = await supabase
    .from("reservations")
    .select("customer_id")
    .eq("id", parsedId.data)
    .maybeSingle();
  if (!reservation) notFound();

  const { data: customer } = await supabase
    .from("customers")
    .select("name")
    .eq("id", reservation.customer_id)
    .maybeSingle();
  if (!customer?.name) notFound();

  redirect(
    "/reservations?invoiceCustomer=" + encodeURIComponent(customer.name),
  );
}
