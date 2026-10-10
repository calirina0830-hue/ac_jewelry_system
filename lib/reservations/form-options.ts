import { createClient } from "@/lib/supabase/server";
import type {
  ReservationCustomerOption,
  ReservationStockOption,
} from "@/types/reservations";

const INITIAL_OPTION_LIMIT = 30;

type OptionsResult = {
  customers: ReservationCustomerOption[];
  stockItems: ReservationStockOption[];
  hasError: boolean;
};

export async function getReservationFormOptions({
  excludeReservationId,
  includeCustomerId,
}: {
  excludeReservationId?: string;
  includeCustomerId?: string;
} = {}): Promise<OptionsResult> {
  const supabase = await createClient();
  const customers: ReservationCustomerOption[] = [];
  const stockItems: ReservationStockOption[] = [];
  let hasError = false;

  const { data: initialCustomers, error: customersError } = await supabase
    .from("customers")
    .select("id, name, facebook_name, phone")
    .is("archived_at", null)
    .order("name")
    .limit(INITIAL_OPTION_LIMIT);

  if (customersError) {
    hasError = true;
  } else {
    customers.push(
      ...(initialCustomers ?? []).map((customer) => ({
        id: customer.id,
        name: customer.name,
        facebookName: customer.facebook_name,
        phone: customer.phone,
      })),
    );
  }

  if (includeCustomerId && !customers.some((item) => item.id === includeCustomerId)) {
    const { data, error } = await supabase
      .from("customers")
      .select("id, name, facebook_name, phone")
      .eq("id", includeCustomerId)
      .maybeSingle();

    if (error) {
      hasError = true;
    } else if (data) {
      customers.unshift({
        id: data.id,
        name: data.name,
        facebookName: data.facebook_name,
        phone: data.phone,
      });
    }
  }

  const { data: initialStock, error: stockError } = await supabase
    .rpc("get_reservable_stock", {
      p_exclude_reservation_id: excludeReservationId ?? null,
    })
    .order("name")
    .limit(INITIAL_OPTION_LIMIT);

  if (stockError) {
    hasError = true;
  } else {
    stockItems.push(
      ...(initialStock ?? []).map((item) => ({
        id: item.id,
        sku: item.sku,
        name: item.name,
        imagePath: item.image_path,
      })),
    );
  }

  return { customers, stockItems, hasError };
}
