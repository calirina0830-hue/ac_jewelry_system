import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/types/database";

type ActivityClient = SupabaseClient<Database>;

export type ActivityEntry = {
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  description?: string | null;
  metadata?: Record<string, unknown>;
};

// Best-effort audit write. Activity logging must never break the operational
// action it is recording, so failures are only reported to server logs.
export async function logActivity(
  client: ActivityClient,
  entry: ActivityEntry,
): Promise<void> {
  try {
    const { error } = await client.rpc("log_admin_activity", {
      p_action: entry.action,
      p_entity_type: entry.entityType ?? null,
      p_entity_id: entry.entityId ?? null,
      p_description: entry.description ?? null,
      p_metadata: entry.metadata ?? {},
    });

    if (error) {
      console.error("Activity logging failed", {
        action: entry.action,
        code: error.code,
        message: error.message,
      });
    }
  } catch (error) {
    console.error("Activity logging threw", {
      action: entry.action,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
