import { NextResponse, type NextRequest } from "next/server";

import { sanitizeSearchTerm } from "@/lib/query";
import { createClient } from "@/lib/supabase/server";
import { reservationIdSchema } from "@/lib/validation/reservations";

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ options: [] }, { status: 401 });
  }

  const search = sanitizeSearchTerm(
    request.nextUrl.searchParams.get("q")?.slice(0, 100) ?? "",
  );
  const rawExclude = request.nextUrl.searchParams.get("exclude");
  const excludeId = rawExclude && reservationIdSchema.safeParse(rawExclude).success
    ? rawExclude
    : null;
  let query = supabase
    .rpc("get_reservable_stock", { p_exclude_reservation_id: excludeId })
    .order("name")
    .limit(25);

  if (search) {
    const pattern = "%" + search + "%";
    query = query.or("name.ilike." + pattern + ",sku.ilike." + pattern + ",category.ilike." + pattern);
  }

  const { data, error } = await query;
  let items = data ?? [];

  if (error || items.some((item) => !item.category)) {
    // If the database RPC is still running an older version without category
    // or if the RPC had an error, fetch from public.stock_items directly.
    let fallbackQuery = supabase
      .from("stock_items")
      .select("id, sku, name, category, image_path")
      .eq("is_active", true)
      .is("archived_at", null)
      .order("name")
      .limit(25);

    if (search) {
      const pattern = "%" + search + "%";
      fallbackQuery = fallbackQuery.or(
        "name.ilike." + pattern + ",sku.ilike." + pattern + ",category.ilike." + pattern,
      );
    }

    const { data: fallbackData } = await fallbackQuery;
    if (fallbackData && fallbackData.length > 0) {
      if (error) {
        items = fallbackData as typeof items;
      } else {
        const categoryById = new Map(
          fallbackData.map((s) => [s.id, s.category]),
        );
        items = items.map((item) => ({
          ...item,
          category: item.category || categoryById.get(item.id) || "",
        }));
      }
    } else if (error) {
      return NextResponse.json({ options: [] }, { status: 500 });
    }
  }

  return NextResponse.json({
    options: items.map((item) => ({
      id: item.id,
      sku: item.sku,
      name: item.name,
      category: item.category ?? "",
      imagePath: item.image_path,
    })),
  });
}
