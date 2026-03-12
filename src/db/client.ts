/**
 * Supabase client initialization and retry helper.
 * Single source of truth for the Supabase singleton.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let supabase: SupabaseClient;

export function initSupabase(url: string, serviceRoleKey: string): void {
  supabase = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function getSupabase(): SupabaseClient {
  return supabase;
}

// ─── Retry helper ───────────────────────────────────────────────────────────

export async function withRetry<T>(
  op: () => Promise<{ data: T; error: any; status?: number }>,
  label: string,
  maxRetries = 2
): Promise<{ data: T; error: any; status?: number }> {
  let lastResult: { data: T; error: any; status?: number } | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    lastResult = await op();
    const status = lastResult.status ?? 0;
    if (!lastResult.error || status < 500) return lastResult;
    if (attempt < maxRetries) {
      const delay = 1000 * 2 ** attempt;
      console.warn(
        `  ${label}: transient error (HTTP ${status}), retry ${attempt + 1}/${maxRetries} in ${delay}ms`
      );
      await Bun.sleep(delay);
    }
  }
  return lastResult!;
}
