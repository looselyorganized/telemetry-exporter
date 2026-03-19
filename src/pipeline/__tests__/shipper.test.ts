import { describe, test, expect, beforeEach } from "bun:test";
import {
  CircuitBreaker,
  groupByTarget,
  sortByPriority,
  filterBlockedByFK,
  SHIPPING_STRATEGIES,
} from "../shipper";
import type { OutboxRow } from "../../db/local";

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
      makeRow({ id: 4, target: "daily_metrics" }),
    ];

    const grouped = groupByTarget(rows);

    expect(grouped.size).toBe(3);
    expect(grouped.get("events")!.length).toBe(2);
    expect(grouped.get("projects")!.length).toBe(1);
    expect(grouped.get("daily_metrics")!.length).toBe(1);
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
  test("sorts targets by strategy priority (projects first, facility_metrics last)", () => {
    const targets = [
      "facility_metrics",
      "project_telemetry",
      "events",
      "projects",
      "daily_metrics",
    ];
    const sorted = sortByPriority(targets);
    expect(sorted).toEqual([
      "projects",
      "events",
      "daily_metrics",
      "project_telemetry",
      "facility_metrics",
    ]);
  });

  test("handles subset of targets", () => {
    const sorted = sortByPriority(["facility_metrics", "projects"]);
    expect(sorted).toEqual(["projects", "facility_metrics"]);
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
// SHIPPING_STRATEGIES sanity checks
// ---------------------------------------------------------------------------

describe("SHIPPING_STRATEGIES", () => {
  test("has all expected targets", () => {
    const targets = Object.keys(SHIPPING_STRATEGIES);
    expect(targets).toContain("projects");
    expect(targets).toContain("events");
    expect(targets).toContain("daily_metrics");
    expect(targets).toContain("project_telemetry");
    expect(targets).toContain("facility_metrics");
  });

  test("projects has highest priority (1)", () => {
    expect(SHIPPING_STRATEGIES.projects.priority).toBe(1);
  });

  test("facility_metrics has lowest priority (5)", () => {
    expect(SHIPPING_STRATEGIES.facility_metrics.priority).toBe(5);
  });

  test("events uses ignoreDuplicates", () => {
    expect(SHIPPING_STRATEGIES.events.ignoreDuplicates).toBe(true);
  });

  test("facility_metrics maps to facility_status table", () => {
    expect(SHIPPING_STRATEGIES.facility_metrics.table).toBe("facility_status");
  });
});
