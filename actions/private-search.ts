"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { requireUser } from "@/lib/auth";
import {
  PRIVATE_SEARCH_COOKIE_NAMES,
  type PrivateSearchScope,
} from "@/lib/private-search";
import { sanitizeSearchTerm, toSearchParams } from "@/lib/query";
import { customerQuerySchema } from "@/lib/validation/customers";
import { reservationQuerySchema } from "@/lib/validation/reservations";
import { shipmentQuerySchema } from "@/lib/validation/shipments";

const SEARCH_COOKIE_MAX_AGE_SECONDS = 15 * 60;
const SEARCH_COOKIE_PATHS: Record<PrivateSearchScope, string> = {
  customers: "/customers",
  reservations: "/reservations",
  shipments: "/shipments",
};

function field(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

function withQuery(path: string, values: Record<string, string | number | undefined>) {
  const query = toSearchParams(values).toString();
  return query ? path + "?" + query : path;
}

async function saveSearchCookie(scope: PrivateSearchScope, term: string) {
  const user = await requireUser();
  const cookieStore = await cookies();
  cookieStore.set(
    PRIVATE_SEARCH_COOKIE_NAMES[scope],
    JSON.stringify({ userId: user.id, term: sanitizeSearchTerm(term).slice(0, 100) }),
    {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: SEARCH_COOKIE_PATHS[scope],
      maxAge: SEARCH_COOKIE_MAX_AGE_SECONDS,
    },
  );
  return user;
}

async function applySearch(
  scope: PrivateSearchScope,
  term: string,
  filters: Record<string, unknown>,
): Promise<never> {
  await saveSearchCookie(scope, term);
  const safeTerm = sanitizeSearchTerm(term).slice(0, 100);

  if (scope === "customers") {
    const parsed = customerQuerySchema.parse({ ...filters, q: safeTerm });
    redirect(
      withQuery("/customers", {
        status: parsed.status,
        sort: parsed.sort,
        direction: parsed.direction,
      }),
    );
  }

  if (scope === "shipments") {
    const parsed = shipmentQuerySchema.parse({ ...filters, q: safeTerm });
    redirect(withQuery("/shipments", { status: parsed.status }));
  }

  const parsed = reservationQuerySchema.parse({ ...filters, q: safeTerm });
  redirect(
    withQuery("/reservations", {
      liveBatch: parsed.liveBatch,
      fromDate: parsed.fromDate,
      toDate: parsed.toDate,
      status: parsed.status,
      archive: parsed.archive,
      sort: parsed.sort,
      direction: parsed.direction,
      pageSize: parsed.pageSize !== "10" ? parsed.pageSize : undefined,
    }),
  );
}

export async function submitCustomerSearch(formData: FormData): Promise<never> {
  return applySearch("customers", field(formData, "q"), {
    status: field(formData, "status"),
    sort: field(formData, "sort"),
    direction: field(formData, "direction"),
  });
}

export async function clearCustomerSearch(): Promise<never> {
  return applySearch("customers", "", {});
}

export async function submitShipmentSearch(formData: FormData): Promise<never> {
  return applySearch("shipments", field(formData, "q"), {
    status: field(formData, "status"),
  });
}

export async function submitReservationSearch(formData: FormData): Promise<never> {
  return applySearch("reservations", field(formData, "q"), {
    liveBatch: field(formData, "liveBatch"),
    fromDate: field(formData, "fromDate"),
    toDate: field(formData, "toDate"),
    status: field(formData, "status"),
    archive: field(formData, "archive"),
    pageSize: field(formData, "pageSize"),
    sort: field(formData, "sort"),
    direction: field(formData, "direction"),
  });
}

export async function applyReservationSearch(
  term: string,
  filters: Record<string, string | number | undefined>,
): Promise<never> {
  return applySearch("reservations", term, filters);
}

export async function clearReservationSearch(
  formData: FormData,
): Promise<never> {
  return applySearch("reservations", "", {
    status: field(formData, "status"),
    archive: field(formData, "archive"),
  });
}
