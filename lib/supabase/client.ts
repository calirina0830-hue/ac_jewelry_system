import { createBrowserClient } from "@supabase/ssr";

import { getSupabaseConfig } from "@/lib/supabase/config";
import type { Database } from "@/types/database";

export function createClient() {
  const config = getSupabaseConfig();

  return createBrowserClient<Database>(
    config.url,
    config.publishableKey,
  );
}
