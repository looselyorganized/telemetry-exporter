/**
 * Shared type definitions for the DB layer.
 */

import type { ModelStats } from "../parsers";

/** Aggregate metrics for the facility status row. */
export interface FacilityMetrics {
  tokensLifetime: number;
  tokensToday: number;
  sessionsLifetime: number;
  messagesLifetime: number;
  modelStats: Record<string, Omit<ModelStats, "model">>;
  hourDistribution: Record<string, number>;
  firstSessionDate: string | null;
}

export interface InsertEventsResult {
  inserted: number;
  errors: number;
  insertedByProject: Record<string, number>;
}

/** project → date → { sessions, messages, toolCalls, agentSpawns, teamMessages } */
export type ProjectEventAggregates = Map<
  string,
  Map<string, { sessions: number; messages: number; toolCalls: number; agentSpawns: number; teamMessages: number }>
>;

export interface FacilityUpdate extends FacilityMetrics {
  status: "active" | "dormant";
  activeAgents: number;
  activeProjects: Array<{ name: string; active: boolean }>;
}

export type FacilityMetricsUpdate = FacilityMetrics;

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
