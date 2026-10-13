import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { ReservationForm } from "@/components/reservations/reservation-form";
import { PageHeader } from "@/components/ui/page-header";
import { getCurrentProfile, roleCanWrite } from "@/lib/auth";
import { getReservationFormOptions } from "@/lib/reservations/form-options";
import { createClient } from "@/lib/supabase/server";
import { reservationIdSchema } from "@/lib/validation/reservations";
import type { ReservationInitialValue } from "@/types/reservations";

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

  const profile = await getCurrentProfile();

  if (!roleCanWrite(profile?.role)) {
    redirect("/reservations/" + id + "?error=not-authorized");
  }

  const supabase = await createClient();
  const [{ data: reservation }, { data: items }] = await Promise.all([
    supabase
      .from("reservations")
      .select("*")
      .eq("id", parsedId.data)
      .maybeSingle(),
    supabase
      .from("reservation_items")
      .select("*")
      .eq("reservation_id", parsedId.data)
      .order("created_at"),
  ]);

  if (!reservation || !items) {
    notFound();
  }

  if (reservation.archived_at || reservation.status !== "reserved") {
    redirect("/reservations/" + id + "?error=not-editable");
  }

  const options = await getReservationFormOptions({
    excludeReservationId: reservation.id,
    includeCustomerId: reservation.customer_id,
  });

  // Query stock_items for current category and info if category is missing or to seed options
  const stockItemIds = [...new Set(items.map((item) => item.stock_item_id).filter(Boolean))];
  const { data: stockRecords } = stockItemIds.length
    ? await supabase
        .from("stock_items")
        .select("id, sku, name, category, image_path")
        .in("id", stockItemIds)
    : { data: [] };
  const stockMap = new Map((stockRecords ?? []).map((s) => [s.id, s]));

  // Ensure stock options include existing reservation items with their categories
  const existingStockIds = new Set(options.stockItems.map((s) => s.id));
  items.forEach((item) => {
    if (item.stock_item_id && !existingStockIds.has(item.stock_item_id)) {
      const stockInfo = stockMap.get(item.stock_item_id);
      options.stockItems.push({
        id: item.stock_item_id,
        sku: stockInfo?.sku ?? item.sku,
        name: stockInfo?.name ?? item.item_name,
        category: stockInfo?.category ?? item.category ?? "",
        imagePath: stockInfo?.image_path ?? item.image_path,
      });
      existingStockIds.add(item.stock_item_id);
    }
  });

  const itemsWithCategory = items.map((item) => {
    const stockInfo = stockMap.get(item.stock_item_id);
    return {
      ...item,
      category: item.category || stockInfo?.category || item.category,
    };
  });

  const initialValue: ReservationInitialValue = {
    id: reservation.id,
    reservationNo: reservation.reservation_no,
    updatedAt: reservation.updated_at,
    customerId: reservation.customer_id,
    reservationDiscount: Number(reservation.discount).toFixed(2),
    downpayment: Number(reservation.downpayment).toFixed(2),
    notes: reservation.notes ?? "",
    items: itemsWithCategory.map((item) => ({
      reservationItemId: item.id,
      stockItemId: item.stock_item_id,
      quantity: item.quantity,
      discount: Number(item.discount).toFixed(2),
      unitPrice: item.price_confirmed
        ? Number(item.unit_price).toFixed(2)
        : "",
      priceConfirmed: item.price_confirmed,
      itemName: item.item_name,
      sku: item.sku,
      category: item.category ?? "",
      imagePath: item.image_path,
      orderedAt: item.ordered_at ?? item.created_at,
    })),
  };

  return (
    <div className="mx-auto max-w-[1400px] px-5 py-8 sm:px-8 lg:px-10 lg:py-10">
      <PageHeader
        description="Adjust the customer, jewelry items, discounts, downpayment, or notes."
        eyebrow={reservation.reservation_no}
        title="Edit reservation"
      />
      {options.hasError && (
        <div
          className="mt-6 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
          role="alert"
        >
          Customer or stock availability could not be fully loaded. Reload before
          saving changes.
        </div>
      )}
      <section className="mt-7 rounded-3xl border border-border bg-white p-5 shadow-card sm:p-8">
        <ReservationForm
          customers={options.customers}
          initialValue={initialValue}
          stockItems={options.stockItems}
        />
      </section>
    </div>
  );
}
