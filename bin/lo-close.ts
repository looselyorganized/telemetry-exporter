#!/usr/bin/env bun
/**
 * LO Facility Close Command
 *
 * Flips facility status to dormant in Supabase.
 * The exporter daemon is unaffected — it's always on, always shipping.
 * "Closing" is a signal for Next.js, not an operational change.
 *
 * Usage:
 *   bun run bin/lo-close.ts
 */

import { createClient } from "@supabase/supabase-js";
import {
  DIM,
  RESET,
  BOLD,
  pass,
  fail,
  printCloseBanner,
  loadEnv,
} from "../src/cli-output";

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  printCloseBanner();

  const { url, key } = loadEnv();

  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // ─── Shift Summary ────────────────────────────────────────────────────────
  // Query today's cost from otel_api_requests
  const { data: costData } = await supabase
    .from("otel_api_requests")
    .select("cost_usd")
    .gte("timestamp", new Date().toISOString().split("T")[0]);

  const todayCost = costData?.reduce((sum: number, r: Record<string, unknown>) => sum + (Number(r.cost_usd) || 0), 0) ?? 0;

  // Query today's sessions from daily_metrics
  const today = new Date().toISOString().split("T")[0];
  const { data: metricsData } = await supabase
    .from("daily_metrics")
    .select("sessions, messages")
    .eq("date", today);

  const sessions = metricsData?.reduce((sum: number, r: Record<string, unknown>) => sum + (Number(r.sessions) || 0), 0) ?? 0;
  const messages = metricsData?.reduce((sum: number, r: Record<string, unknown>) => sum + (Number(r.messages) || 0), 0) ?? 0;

  console.log();
  console.log(`  ${DIM}── Shift Summary ──────────────────────${RESET}`);
  console.log(`  ${BOLD}$${todayCost.toFixed(2)}${RESET} spent · ${sessions} sessions · ${messages} messages`);

  // 1. Flip status to dormant
  const { error } = await supabase
    .from("facility_status")
    .update({ status: "dormant", updated_at: new Date().toISOString() })
    .eq("id", 1);

  if (error) {
    fail("Facility", `Failed to set status (${error.message})`);
    process.exit(1);
  }

  pass("Facility", "Status → dormant");

  console.log();
  console.log(`  ${DIM}── Facility Closed ────────────────────${RESET}`);
  console.log(`  ${BOLD}Status:${RESET} dormant (exporter continues running)`);
  console.log();
}

main().catch((err) => {
  console.error(`  Unexpected error: ${err.message}`);
  process.exit(1);
});
