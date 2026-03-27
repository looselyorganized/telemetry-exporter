/**
 * Shared type definitions for the DB layer.
 */

/** project → date → { sessions, messages, toolCalls, agentSpawns, teamMessages } */
export type ProjectEventAggregates = Map<
  string,
  Map<string, { sessions: number; messages: number; toolCalls: number; agentSpawns: number; teamMessages: number }>
>;

export interface ProjectTelemetryUpdate {
  projId: string;
  tokensLifetime: number;
  tokensToday: number;
  modelsToday: Record<string, number>;
  sessionsLifetime: number;
  messagesLifetime: number;
  toolCallsLifetime: number;
  agentSpawnsLifetime: number;
  teamMessagesLifetime: number;
  activeAgents: number;
  agentCount: number;
}

/** Format a token count as a human-readable string (e.g. "12.3M"). */
export function formatTokens(n: number): string {
  return (n / 1e6).toFixed(1) + "M";
}

export interface ShipResult {
  shipped: number;
  failed: number;
  retriesScheduled: number;
  circuitBreakerState: "closed" | "open" | "half-open";
  byTarget: Record<string, { shipped: number; failed: number }>;
}

export interface ShippingStrategy {
  table: string;
  method: "upsert" | "update" | "insert";
  onConflict?: string;
  filter?: Record<string, unknown>;
  ignoreDuplicates?: boolean;
  excludeFields?: string[];
  batchSize: number;
  fallbackToPerRow: boolean;
  priority: number;
}
