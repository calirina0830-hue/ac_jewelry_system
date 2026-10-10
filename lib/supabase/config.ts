type SupabaseConfig = {
  url: string;
  publishableKey: string;
};

type SupabaseDiagnosticsOptions = {
  context: string;
  redirectTo?: string;
};

function parseHttpUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

function getSiteHost(): string | null {
  const configuredSiteUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (configuredSiteUrl) {
    return parseHttpUrl(configuredSiteUrl)?.hostname ?? null;
  }

  const vercelUrl = process.env.VERCEL_URL?.trim();
  if (!vercelUrl) return null;
  return parseHttpUrl("https://" + vercelUrl)?.hostname ?? null;
}

export function getSupabaseConfig(): SupabaseConfig {
  const rawUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const publishableKey =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();

  if (!rawUrl) {
    throw new Error(
      "Missing required environment variable NEXT_PUBLIC_SUPABASE_URL.",
    );
  }

  const parsedUrl = parseHttpUrl(rawUrl);
  if (!parsedUrl) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL must be an absolute HTTP(S) Supabase project URL.",
    );
  }

  if (parsedUrl.pathname !== "/" || parsedUrl.search || parsedUrl.hash) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL must be the Supabase project origin without a path, query, or fragment.",
    );
  }

  const siteHost = getSiteHost();
  if (siteHost && parsedUrl.hostname === siteHost) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL points to the application host. Configure the Supabase project URL instead.",
    );
  }

  if (!publishableKey) {
    throw new Error(
      "Missing required environment variable NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.",
    );
  }

  return {
    url: parsedUrl.origin,
    publishableKey,
  };
}

export function logSupabaseDiagnostics({
  context,
  redirectTo,
}: SupabaseDiagnosticsOptions): void {
  const rawSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const rawSiteUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  const supabaseUrl = rawSupabaseUrl ? parseHttpUrl(rawSupabaseUrl) : null;

  console.info("[supabase-config]", {
    context,
    supabaseUrlPresent: Boolean(rawSupabaseUrl),
    publishableKeyPresent: Boolean(
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim(),
    ),
    siteUrlPresent: Boolean(rawSiteUrl || process.env.VERCEL_URL?.trim()),
    supabaseHost: supabaseUrl?.hostname ?? "missing-or-invalid",
    siteHost: getSiteHost() ?? "missing-or-invalid",
    ...(redirectTo ? { redirectTo } : {}),
  });
}
