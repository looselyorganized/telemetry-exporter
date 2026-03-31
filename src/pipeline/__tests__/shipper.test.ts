import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  CircuitBreaker,
  groupByTarget,
  sortByPriority,
  filterBlockedByFK,
  SHIPPING_STRATEGIES,
  Shipper,
} from "../shipper";
import type { OutboxRow } from "../../db/local";
import { initLocal, enqueue, dequeueUnshipped, enqueueArchive, dequeueUnshippedArchive, outboxDepth, archiveDepth } from "../../db/local";
import type { SupabaseClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRow(overrides: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: 1,
    target: "events",
    payload: JSON.stringify({ project_id: "proj_abc", event_type: "test" }),
    status: "pending",
    created_at: new Date().toISOString(),
    shipped_at: null,
    error: null,
    retry_count: 0,
    last_error_at: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// CircuitBreaker
// ---------------------------------------------------------------------------

describe("CircuitBreaker", () => {
  test("starts closed", () => {
    const cb = new CircuitBreaker();
    expect(cb.state).toBe("closed");
    expect(cb.isOpen()).toBe(false);
  });

  test("opens after 3 consecutive failures", () => {
    const cb = new CircuitBreaker();
    cb.recordFailure();
    expect(cb.state).toBe("closed");
    cb.recordFailure();
    expect(cb.state).toBe("closed");
    cb.recordFailure();
    expect(cb.state).toBe("open");
    expect(cb.isOpen()).toBe(true);
  });

  test("resets failure count on success", () => {
    const cb = new CircuitBreaker();
    cb.recordFailure();
    cb.recordFailure();
    cb.recordSuccess();
    expect(cb.state).toBe("closed");
    // Need 3 more failures to open
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.state).toBe("closed");
    cb.recordFailure();
    expect(cb.state).toBe("open");
  });

  test("transitions to half-open after timeout", () => {
    const cb = new CircuitBreaker(100); // 100ms timeout
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.state).toBe("open");
    expect(cb.isOpen()).toBe(true);

    Bun.sleepSync(110);

    // After timeout, isOpen() transitions to half-open and returns false
    expect(cb.isOpen()).toBe(false);
    expect(cb.state).toBe("half-open");
  });

  test("half-open returns to closed on success", () => {
    const cb = new CircuitBreaker(100);
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    Bun.sleepSync(110);
    cb.isOpen(); // trigger half-open transition
    expect(cb.state).toBe("half-open");

    cb.recordSuccess();
    expect(cb.state).toBe("closed");
    expect(cb.isOpen()).toBe(false);
  });

  test("half-open returns to open on failure", () => {
    const cb = new CircuitBreaker(100);
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    Bun.sleepSync(110);
    cb.isOpen(); // trigger half-open transition
    expect(cb.state).toBe("half-open");

    cb.recordFailure();
    expect(cb.state).toBe("open");
    expect(cb.isOpen()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// groupByTarget
// ---------------------------------------------------------------------------

describe("groupByTarget", () => {
  test("groups rows by target field", () => {
    const rows: OutboxRow[] = [
      makeRow({ id: 1, target: "events" }),
      makeRow({ id: 2, target: "projects" }),
      makeRow({ id: 3, target: "events" }),
      makeRow({ id: 4, target: "daily_rollups" }),
    ];

    const grouped = groupByTarget(rows);

    expect(grouped.size).toBe(3);
    expect(grouped.get("events")!.length).toBe(2);
    expect(grouped.get("projects")!.length).toBe(1);
    expect(grouped.get("daily_rollups")!.length).toBe(1);
    expect(grouped.get("events")!.map((r) => r.id)).toEqual([1, 3]);
  });

  test("returns empty map for empty input", () => {
    const grouped = groupByTarget([]);
    expect(grouped.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// sortByPriority
// ---------------------------------------------------------------------------

describe("sortByPriority", () => {
  test("sorts targets by strategy priority (projects first)", () => {
    const targets = [
      "daily_rollups",
      "events",
      "projects",
      "sessions",
    ];
    const sorted = sortByPriority(targets);
    expect(sorted).toEqual([
      "projects",
      "sessions",
      "events",
      "daily_rollups",
    ]);
  });

  test("handles subset of targets", () => {
    const sorted = sortByPriority(["alerts", "projects"]);
    expect(sorted).toEqual(["projects", "alerts"]);
  });

  test("unknown targets are sorted last (after known ones)", () => {
    const sorted = sortByPriority(["unknown_target", "projects"]);
    expect(sorted[0]).toBe("projects");
    expect(sorted[1]).toBe("unknown_target");
  });
});

// ---------------------------------------------------------------------------
// filterBlockedByFK
// ---------------------------------------------------------------------------

describe("filterBlockedByFK", () => {
  test("blocks events for projects with unshipped project registration", () => {
    const blockedProjIds = new Set(["proj_blocked"]);
    const rows: OutboxRow[] = [
      makeRow({
        id: 1,
        target: "events",
        payload: JSON.stringify({ project_id: "proj_blocked", event_type: "msg" }),
      }),
      makeRow({
        id: 2,
        target: "events",
        payload: JSON.stringify({ project_id: "proj_allowed", event_type: "msg" }),
      }),
    ];

    const { allowed, blocked } = filterBlockedByFK(rows, blockedProjIds);

    expect(allowed.length).toBe(1);
    expect(allowed[0].id).toBe(2);
    expect(blocked.length).toBe(1);
    expect(blocked[0].id).toBe(1);
  });

  test("passes events for non-blocked projects", () => {
    const blockedProjIds = new Set<string>();
    const rows: OutboxRow[] = [
      makeRow({ id: 1, payload: JSON.stringify({ project_id: "proj_a" }) }),
      makeRow({ id: 2, payload: JSON.stringify({ project_id: "proj_b" }) }),
    ];

    const { allowed, blocked } = filterBlockedByFK(rows, blockedProjIds);

    expect(allowed.length).toBe(2);
    expect(blocked.length).toBe(0);
  });

  test("blocks rows whose id field matches blockedProjIds (project rows)", () => {
    const blockedProjIds = new Set(["proj_new"]);
    const rows: OutboxRow[] = [
      makeRow({
        id: 1,
        target: "projects",
        payload: JSON.stringify({ id: "proj_new", name: "New Project" }),
      }),
      makeRow({
        id: 2,
        target: "projects",
        payload: JSON.stringify({ id: "proj_existing", name: "Existing" }),
      }),
    ];

    const { allowed, blocked } = filterBlockedByFK(rows, blockedProjIds);

    expect(allowed.length).toBe(1);
    expect(allowed[0].id).toBe(2);
    expect(blocked.length).toBe(1);
    expect(blocked[0].id).toBe(1);
  });

  test("allows all rows when blocked set is empty", () => {
    const rows: OutboxRow[] = [
      makeRow({ id: 1, payload: JSON.stringify({ project_id: "proj_a" }) }),
      makeRow({ id: 2, payload: JSON.stringify({ project_id: "proj_b" }) }),
    ];

    const { allowed, blocked } = filterBlockedByFK(rows, new Set());
    expect(allowed.length).toBe(2);
    expect(blocked.length).toBe(0);
  });

  test("gracefully handles malformed payload JSON", () => {
    const blockedProjIds = new Set(["proj_x"]);
    const rows: OutboxRow[] = [
      makeRow({ id: 1, payload: "not-valid-json" }),
    ];

    // Should not throw; row with malformed JSON passes through (no project_id to block)
    const { allowed, blocked } = filterBlockedByFK(rows, blockedProjIds);
    expect(allowed.length).toBe(1);
    expect(blocked.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Shipper class
// ---------------------------------------------------------------------------

type MockResponse = { data?: any; error?: any; status?: number };

function mockSupabase(responses: Record<string, MockResponse>): SupabaseClient {
  return {
    from: (table: string) => {
      const resp = responses[table] ?? { data: [], error: null };
      return {
        upsert: (_payload: any, _opts?: any) => Promise.resolve(resp),
        update: (_payload: any) => ({
          match: (_filter: any) => Promise.resolve(resp),
        }),
        select: (_cols: string) => ({
          in: (_col: string, _vals: any[]) => Promise.resolve(resp),
        }),
      };
    },
  } as unknown as SupabaseClient;
}

let tmpDir: string;
let dbPath: string;

function setupDb(): void {
  tmpDir = mkdtempSync(join(tmpdir(), "shipper-test-"));
  dbPath = join(tmpDir, "outbox.db");
  initLocal(dbPath);
}

function teardownDb(): void {
  rmSync(tmpDir, { recursive: true, force: true });
}

describe("Shipper.ship()", () => {
  beforeEach(setupDb);
  afterEach(teardownDb);

  test("dequeues pending rows and marks them shipped on success", async () => {
    enqueue("projects", { id: "proj_a", name: "Alpha" });
    enqueue("events", { project_id: "proj_a", event_type: "msg", event_text: "hi", timestamp: "2025-01-01T00:00:00Z" });

    const supabase = mockSupabase({
      projects: { data: [], error: null },
      events: { data: [], error: null },
    });
    const shipper = new Shipper(supabase);
    const result = await shipper.ship();

    expect(result.shipped).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.retriesScheduled).toBe(0);
    expect(result.circuitBreakerState).toBe("closed");
    // Both should now be shipped — depth returns to 0
    expect(outboxDepth()).toBe(0);
  });

  test("returns empty result when circuit breaker is open", async () => {
    enqueue("projects", { id: "proj_b", name: "Beta" });

    const supabase = mockSupabase({});
    const shipper = new Shipper(supabase);
    // Force circuit open
    (shipper as any).breaker.recordFailure();
    (shipper as any).breaker.recordFailure();
    (shipper as any).breaker.recordFailure();
    expect((shipper as any).breaker.isOpen()).toBe(true);

    const result = await shipper.ship();
    expect(result.shipped).toBe(0);
    expect(result.circuitBreakerState).toBe("open");
    // Row still pending
    expect(outboxDepth()).toBe(1);
  });

  test("processes targets in priority order (projects before events)", async () => {
    const order: string[] = [];
    const supabase = {
      from: (table: string) => ({
        upsert: (_p: any, _o?: any) => {
          order.push(table);
          return Promise.resolve({ data: [], error: null });
        },
        update: (_p: any) => ({
          match: (_f: any) => {
            order.push(table);
            return Promise.resolve({ data: [], error: null });
          },
        }),
        select: (_c: string) => ({
          in: (_col: string, _vals: any[]) => Promise.resolve({ data: [], error: null }),
        }),
      }),
    } as unknown as SupabaseClient;

    enqueue("events", { project_id: "proj_a", event_type: "msg", event_text: "hi", timestamp: "2025-01-01T00:00:00Z" });
    enqueue("projects", { id: "proj_a", name: "Alpha" });

    const shipper = new Shipper(supabase);
    await shipper.ship();

    // projects (priority 1) must appear before events (priority 2)
    expect(order.indexOf("projects")).toBeLessThan(order.indexOf("events"));
  });

  test("marks transient error on 5xx — row stays pending for retry", async () => {
    enqueue("projects", { id: "proj_c", name: "Gamma" });

    const supabase = mockSupabase({
      projects: { data: null, error: { message: "gateway timeout", code: "504" }, status: 504 },
    });
    const shipper = new Shipper(supabase);
    const result = await shipper.ship();

    expect(result.shipped).toBe(0);
    expect(result.retriesScheduled).toBe(1);
    // Row still pending (transient keeps it pending until retry_count >= 10)
    expect(outboxDepth()).toBe(1);
  });

  test("marks failed on 4xx — permanent failure", async () => {
    enqueue("projects", { id: "proj_d", name: "Delta" });

    const supabase = mockSupabase({
      projects: { data: null, error: { message: "conflict" }, status: 409 },
    });
    const shipper = new Shipper(supabase);
    const result = await shipper.ship();

    expect(result.shipped).toBe(0);
    expect(result.failed).toBe(1);
    // Row is now failed, not pending
    expect(outboxDepth()).toBe(0);
  });

  test("blocks events for projIds with failed project registration", async () => {
    enqueue("projects", { id: "proj_fail", name: "Failing Project" });
    enqueue("events", { project_id: "proj_fail", event_type: "msg", event_text: "hi", timestamp: "2025-01-01T00:00:00Z" });
    enqueue("events", { project_id: "proj_ok", event_type: "msg", event_text: "ok", timestamp: "2025-01-01T00:00:00Z" });

    const supabase = mockSupabase({
      projects: { data: null, error: { message: "not found" }, status: 404 },
      events: { data: [], error: null },
    });

    const shipper = new Shipper(supabase);
    const result = await shipper.ship();

    // proj_fail's project row permanently failed, events for proj_fail are blocked
    // proj_ok event should ship
    expect(result.byTarget["projects"]?.failed).toBe(1);
    // The blocked event stays pending (not shipped, not failed)
    const remaining = dequeueUnshipped(100);
    const blockedEvent = remaining.find(r => r.target === "events" && r.payload.includes("proj_fail"));
    expect(blockedEvent).toBeDefined();
  });

  test("returns correct ShipResult counts", async () => {
    enqueue("projects", { id: "proj_a", name: "Alpha" });
    enqueue("events", { project_id: "proj_a", event_type: "t", event_text: "x", timestamp: "2025-01-01T00:00:00Z" });
    enqueue("events", { project_id: "proj_a", event_type: "t", event_text: "y", timestamp: "2025-01-01T00:00:01Z" });

    const supabase = mockSupabase({
      projects: { data: [], error: null },
      events: { data: [], error: null },
    });
    const shipper = new Shipper(supabase);
    const result = await shipper.ship();

    expect(result.shipped).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.retriesScheduled).toBe(0);
    expect(result.byTarget["projects"]?.shipped).toBe(1);
    expect(result.byTarget["events"]?.shipped).toBe(2);
  });
});

describe("Shipper.shipArchive()", () => {
  beforeEach(setupDb);
  afterEach(teardownDb);

  test("ships archive rows and marks them shipped", async () => {
    enqueueArchive("event", JSON.stringify({ project_id: "proj_a" }), "hash1");
    enqueueArchive("event", JSON.stringify({ project_id: "proj_b" }), "hash2");

    const supabase = mockSupabase({
      outbox_archive: { data: [], error: null },
    });
    const shipper = new Shipper(supabase);
    const result = await shipper.shipArchive();

    expect(result.shipped).toBe(2);
    expect(result.failed).toBe(0);
    expect(archiveDepth()).toBe(0);
  });

  test("marks archive rows with transient error on 5xx", async () => {
    enqueueArchive("event", JSON.stringify({ project_id: "proj_a" }), "hash3");

    const supabase = mockSupabase({
      outbox_archive: { data: null, error: { message: "server error" }, status: 503 },
    });
    const shipper = new Shipper(supabase);
    const result = await shipper.shipArchive();

    expect(result.shipped).toBe(0);
    // Archive rows stay unshipped on error
    expect(archiveDepth()).toBe(1);
  });
});

describe("Shipper delegation methods", () => {
  beforeEach(setupDb);
  afterEach(teardownDb);

  test("pruneShipped delegates to local pruneShipped", () => {
    const supabase = mockSupabase({});
    const shipper = new Shipper(supabase);
    // Should not throw when called
    expect(() => shipper.pruneShipped(7)).not.toThrow();
  });

  test("outboxDepth returns correct pending count", () => {
    enqueue("events", { project_id: "proj_a" });
    enqueue("events", { project_id: "proj_b" });

    const supabase = mockSupabase({});
    const shipper = new Shipper(supabase);
    expect(shipper.outboxDepth()).toBe(2);
  });

  test("archiveDepth returns correct unshipped archive count", () => {
    enqueueArchive("event", JSON.stringify({ a: 1 }), "h1");
    enqueueArchive("event", JSON.stringify({ a: 2 }), "h2");

    const supabase = mockSupabase({});
    const shipper = new Shipper(supabase);
    expect(shipper.archiveDepth()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// SHIPPING_STRATEGIES sanity checks
// ---------------------------------------------------------------------------

describe("SHIPPING_STRATEGIES", () => {
  test("has all expected targets", () => {
    const targets = Object.keys(SHIPPING_STRATEGIES);
    expect(targets).toContain("sessions");
    expect(targets).toContain("projects");
    expect(targets).toContain("events");
    expect(targets).toContain("otel_api_requests");
    expect(targets).toContain("daily_rollups");
    expect(targets).toContain("alerts");
  });

  test("does not contain deprecated targets", () => {
    const targets = Object.keys(SHIPPING_STRATEGIES);
    expect(targets).not.toContain("daily_metrics");
    expect(targets).not.toContain("project_telemetry");
    expect(targets).not.toContain("facility_metrics");
  });

  test("projects has highest priority (0)", () => {
    expect(SHIPPING_STRATEGIES.projects.priority).toBe(0);
  });

  test("sessions has priority 1", () => {
    expect(SHIPPING_STRATEGIES.sessions.priority).toBe(1);
  });

  test("events uses ignoreDuplicates", () => {
    expect(SHIPPING_STRATEGIES.events.ignoreDuplicates).toBe(true);
  });
});
