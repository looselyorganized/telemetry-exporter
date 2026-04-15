import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { unlinkSync, existsSync } from "fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { initLocal, getLocal, closeLocal, enqueue } from "../../db/local";
import { ProjectBlocker } from "../project-blocker";
import { Shipper } from "../shipper";
import { SupabaseFake } from "./_fixtures/supabase-fake";

const TEST_DB_PATH = "/tmp/lo-test-project-blocker-int.db";

function deleteTestFiles() {
  for (const suffix of ["", "-wal", "-shm"]) {
    const path = `${TEST_DB_PATH}${suffix}`;
    if (existsSync(path)) unlinkSync(path);
  }
}

function setup() {
  initLocal(TEST_DB_PATH);
  const db = getLocal();
  const supabase = new SupabaseFake();
  const blocker = new ProjectBlocker(db);
  blocker.loadBlocked();
  const shipper = new Shipper(supabase as unknown as SupabaseClient, blocker);
  return { db, supabase, blocker, shipper };
}

function captureWarn(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const orig = console.warn;
  console.warn = (msg: unknown) => {
    logs.push(String(msg));
  };
  return { logs, restore: () => { console.warn = orig; } };
}

beforeEach(() => {
  deleteTestFiles();
});

afterEach(() => {
  closeLocal();
  deleteTestFiles();
});

describe("slug collision — the augment-1 regression", () => {
  it("local slug collides with pre-existing remote row → block + loud log + no FK cascade", async () => {
    const { db, supabase, blocker, shipper } = setup();

    // Pre-existing remote row with the same slug but a DIFFERENT proj_id.
    supabase.seed("projects", [
      { id: "proj_REMOTE", slug: "augment-1", name: "augment-1 (legacy)" },
    ]);

    // Local enqueues: register project + send events + rollup.
    enqueue("projects", { id: "proj_LOCAL", slug: "augment-1" });
    enqueue("events", {
      project_id: "proj_LOCAL",
      event_type: "msg",
      event_text: "hi",
      timestamp: "2026-04-14T00:00:00Z",
    });
    enqueue("daily_rollups", {
      project_id: "proj_LOCAL",
      date: "2026-04-14",
      tokens: {},
    });

    const { logs, restore } = captureWarn();
    try {
      await shipper.ship();
    } finally {
      restore();
    }

    // (a) projects_blocked row inserted
    const blockedRow = db
      .query("SELECT * FROM projects_blocked WHERE proj_id=?")
      .get("proj_LOCAL") as {
      reason: string;
      slug: string;
      resolved_at: string | null;
    } | null;
    expect(blockedRow).not.toBe(null);
    expect(blockedRow!.reason).toBe("slug_collision");
    expect(blockedRow!.slug).toBe("augment-1");
    expect(blockedRow!.resolved_at).toBe(null);

    // (b) exactly one structured 'project_blocked' log emitted
    const structuredLogs = logs
      .map((m) => {
        try {
          return JSON.parse(m);
        } catch {
          return null;
        }
      })
      .filter((o) => o && o.evt === "project_blocked");
    expect(structuredLogs).toHaveLength(1);
    expect(structuredLogs[0]).toMatchObject({
      evt: "project_blocked",
      proj_id: "proj_LOCAL",
      slug: "augment-1",
      reason: "slug_collision",
    });

    // (c) Supabase fake saw NO insert attempts on events/daily_rollups for proj_LOCAL
    const dependentInserts = supabase.insertLog.filter(
      (i) => i.table === "events" || i.table === "daily_rollups"
    );
    expect(dependentInserts).toHaveLength(0);

    // (d) blocker in-memory state reflects the block
    expect(blocker.isBlocked("proj_LOCAL")).toBe(true);
  });

  it("second ship cycle with same block: no duplicate log", async () => {
    const { supabase, shipper } = setup();
    supabase.seed("projects", [{ id: "proj_REMOTE", slug: "augment-1" }]);
    enqueue("projects", { id: "proj_LOCAL", slug: "augment-1" });

    const { logs, restore } = captureWarn();
    try {
      await shipper.ship();
      await shipper.ship();
      await shipper.ship();
    } finally {
      restore();
    }

    const structured = logs
      .map((m) => {
        try {
          return JSON.parse(m);
        } catch {
          return null;
        }
      })
      .filter((o) => o && o.evt === "project_blocked");
    expect(structured).toHaveLength(1); // NOT 3
  });

  it("block survives simulated daemon restart (new ProjectBlocker sees existing block)", () => {
    initLocal(TEST_DB_PATH);
    const db = getLocal();

    db.query(
      `INSERT INTO projects_blocked (proj_id, slug, reason, error_message, first_seen_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run("proj_PERSISTED", "s", "slug_collision", "e", new Date().toISOString());

    // Simulate restart: new blocker instance, same db
    const blocker2 = new ProjectBlocker(db);
    blocker2.loadBlocked();
    expect(blocker2.isBlocked("proj_PERSISTED")).toBe(true);
  });
});
