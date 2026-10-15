import { NextResponse, type NextRequest } from "next/server";

import { sanitizeSearchTerm } from "@/lib/query";
import { createClient } from "@/lib/supabase/server";
import { z } from "zod";

const customerSearchSchema = z.object({
  q: z.string().trim().max(100).optional().default(""),
});

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ options: [] }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const parsedBody = customerSearchSchema.safeParse(body);
  if (!parsedBody.success) {
    return NextResponse.json({ options: [] }, { status: 400 });
  }
  const search = sanitizeSearchTerm(parsedBody.data.q);
  let query = supabase
    .from("customers")
    .select("id, name, facebook_name, phone")
    .is("archived_at", null)
    .order("name")
    .limit(25);

  if (search) {
    const pattern = "%" + search + "%";
    query = query.or(
      "name.ilike." + pattern + ",facebook_name.ilike." + pattern,
    );
  }

  const { data, error } = await query;
  if (error) {
    return NextResponse.json({ options: [] }, { status: 500 });
  }

  return NextResponse.json({
    options: (data ?? []).map((customer) => ({
      id: customer.id,
      name: customer.name,
      facebookName: customer.facebook_name,
      phone: customer.phone,
    })),
  });
}
