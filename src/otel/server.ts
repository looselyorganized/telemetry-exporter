/**
 * OTLP HTTP receiver — accepts OpenTelemetry data on 127.0.0.1:4318.
 *
 * Writes events to SQLite (otel_events table) synchronously BEFORE
 * returning HTTP 200. This ensures no data is lost — if the write fails,
 * the client receives 503 and will retry per OTel SDK backoff.
 *
 * Rate limits per session_id (200 events/min) to prevent one runaway
 * session from blocking others.
 */

import { parseOtlpLogs, parseOtlpMetrics, parseOtlpTraces, classifyEvent } from "./parser";
import type { OtelLogEvent, OtelMetricEvent, OtelSpanEvent } from "./parser";
import { insertOtelEvent } from "../db/local";
import { reportError } from "../errors";

// ─── Constants ──────────────────────────────────────────────────────────────

const OTLP_HOST = "127.0.0.1";
const OTLP_PORT = 4318;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 200;

// ─── Rate limiter ───────────────────────────────────────────────────────────

interface RateWindow {
  count: number;
  windowStart: number;
}

const rateLimits = new Map<string, RateWindow>();

function checkRateLimit(sessionId: string | null): boolean {
  const key = sessionId ?? "__global__";
  const now = Date.now();
  let window = rateLimits.get(key);

  if (!window || now - window.windowStart > RATE_LIMIT_WINDOW_MS) {
    window = { count: 0, windowStart: now };
    rateLimits.set(key, window);
  }

  window.count++;
  return window.count <= RATE_LIMIT_MAX;
}

/** Prune expired rate limit windows (call periodically). */
export function pruneRateLimits(): void {
  const now = Date.now();
  for (const [key, window] of rateLimits) {
    if (now - window.windowStart > RATE_LIMIT_WINDOW_MS) {
      rateLimits.delete(key);
    }
  }
}

// ─── Request handlers ───────────────────────────────────────────────────────

function handleLogs(body: unknown): { stored: number; rateLimited: number } {
  const events = parseOtlpLogs(body);
  let stored = 0;
  let rateLimited = 0;

  for (const event of events) {
    if (!checkRateLimit(event.sessionId)) {
      rateLimited++;
      continue;
    }
    const eventClass = classifyEvent(event.eventType);
    insertOtelEvent(eventClass, event.sessionId, event.rawPayload);
    stored++;
  }

  return { stored, rateLimited };
}

function handleMetrics(body: unknown): { stored: number; rateLimited: number } {
  const events = parseOtlpMetrics(body);
  let stored = 0;
  let rateLimited = 0;

  for (const event of events) {
    if (!checkRateLimit(event.sessionId)) {
      rateLimited++;
      continue;
    }
    insertOtelEvent("metric", event.sessionId, event.rawPayload);
    stored++;
  }

  return { stored, rateLimited };
}

function handleTraces(body: unknown): { stored: number; rateLimited: number } {
  const events = parseOtlpTraces(body);
  let stored = 0;
  let rateLimited = 0;

  for (const event of events) {
    if (!checkRateLimit(event.sessionId)) {
      rateLimited++;
      continue;
    }
    insertOtelEvent("span", event.sessionId, event.rawPayload);
    stored++;
  }

  return { stored, rateLimited };
}

// ─── Server ─────────────────────────────────────────────────────────────────

let server: ReturnType<typeof Bun.serve> | null = null;

export interface OtlpServerOptions {
  port?: number;
  hostname?: string;
}

/**
 * Start the OTLP HTTP receiver.
 * Returns immediately — the server runs in the background.
 */
export function startOtlpServer(options: OtlpServerOptions = {}): void {
  const port = options.port ?? OTLP_PORT;
  const hostname = options.hostname ?? OTLP_HOST;

  if (server) {
    throw new Error("OTLP server already running");
  }

  server = Bun.serve({
    port,
    hostname,
    fetch: handleRequest,
  });

  console.log(`  OTLP: http://${hostname}:${port}`);
}

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  // Only accept POST for OTLP endpoints
  if (req.method !== "POST") {
    return new Response(null, { status: 405 });
  }

  // Route to handler
  let handler: ((body: unknown) => { stored: number; rateLimited: number }) | null = null;
  if (path === "/v1/logs") handler = handleLogs;
  else if (path === "/v1/metrics") handler = handleMetrics;
  else if (path === "/v1/traces") handler = handleTraces;

  if (!handler) {
    return new Response(null, { status: 404 });
  }

  // Parse JSON body
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Process and store
  try {
    const result = handler(body);

    if (result.rateLimited > 0 && result.stored === 0) {
      return new Response(JSON.stringify({ error: "Rate limited" }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({
      stored: result.stored,
      rateLimited: result.rateLimited,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    reportError("otel_ingestion", `OTLP handler error: ${err instanceof Error ? err.message : String(err)}`);
    return new Response(JSON.stringify({ error: "Storage failure" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }
}

/**
 * Gracefully stop the OTLP server.
 * Finishes in-flight requests, then releases the socket.
 */
export function stopOtlpServer(): void {
  if (server) {
    server.stop(true); // graceful: finish in-flight
    server = null;
  }
}

/** Check if the server is currently running. */
export function isOtlpServerRunning(): boolean {
  return server !== null;
}
