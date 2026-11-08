import { createClient } from "@/lib/supabase/server";
import type { ReservationCustomerOption } from "@/types/reservations";

const INITIAL_OPTION_LIMIT = 30;

type OptionsResult = {
  customers: ReservationCustomerOption[];
  hasError: boolean;
};

export async function getReservationFormOptions({
  includeCustomerId,
}: {
  includeCustomerId?: string;
} = {}): Promise<OptionsResult> {
  const supabase = await createClient();
  const customers: ReservationCustomerOption[] = [];
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

  return { customers, hasError };
}
