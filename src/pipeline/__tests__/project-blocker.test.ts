import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { unlinkSync, existsSync } from "fs";
import { initLocal, getLocal, closeLocal } from "../../db/local";
import { ProjectBlocker } from "../project-blocker";

const TEST_DB_PATH = "/tmp/lo-test-project-blocker.db";

function deleteTestFiles() {
  for (const suffix of ["", "-wal", "-shm"]) {
    const path = `${TEST_DB_PATH}${suffix}`;
    if (existsSync(path)) unlinkSync(path);
  }
}

beforeEach(() => {
  deleteTestFiles();
  initLocal(TEST_DB_PATH);
});

afterEach(() => {
  closeLocal();
  deleteTestFiles();
});

describe("ProjectBlocker.loadBlocked + isBlocked", () => {
  it("isBlocked returns false for unknown proj_id before any block is persisted", () => {
    const blocker = new ProjectBlocker(getLocal());
    blocker.loadBlocked();
    expect(blocker.isBlocked("proj_never_seen")).toBe(false);
  });

  it("isBlocked returns true for a persisted open block after load", () => {
    const db = getLocal();
    db.query(
      `INSERT INTO projects_blocked (proj_id, slug, reason, error_message, first_seen_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run("proj_X", "slug-x", "slug_collision", "dup", new Date().toISOString());

    const blocker = new ProjectBlocker(db);
    blocker.loadBlocked();
    expect(blocker.isBlocked("proj_X")).toBe(true);
  });

  it("isBlocked returns false for resolved blocks after load", () => {
    const db = getLocal();
    db.query(
      `INSERT INTO projects_blocked (proj_id, slug, reason, error_message, first_seen_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run("proj_R", "slug-r", "slug_collision", "dup", new Date().toISOString(), new Date().toISOString());

    const blocker = new ProjectBlocker(db);
    blocker.loadBlocked();
    expect(blocker.isBlocked("proj_R")).toBe(false);
  });

  it("getBlocked returns a fresh copy of the in-memory Set", () => {
    const db = getLocal();
    db.query(
      `INSERT INTO projects_blocked (proj_id, slug, reason, error_message, first_seen_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run("proj_Y", "slug-y", "fk_cascade", "fk", new Date().toISOString());

    const blocker = new ProjectBlocker(db);
    blocker.loadBlocked();
    const snapshot = blocker.getBlocked();
    expect(snapshot.has("proj_Y")).toBe(true);

    // Mutating the snapshot must not affect subsequent isBlocked checks.
    snapshot.delete("proj_Y");
    expect(blocker.isBlocked("proj_Y")).toBe(true);
  });
});

describe("ProjectBlocker.recordBlock", () => {
  it("first block returns isNew=true and persists the row", () => {
    const db = getLocal();
    const blocker = new ProjectBlocker(db);
    blocker.loadBlocked();

    const isNew = blocker.recordBlock("proj_A", "slug-a", "slug_collision", "dup key value");

    expect(isNew).toBe(true);
    expect(blocker.isBlocked("proj_A")).toBe(true);
    const row = db.query("SELECT * FROM projects_blocked WHERE proj_id=?").get("proj_A") as {
      slug: string;
      reason: string;
      error_message: string;
      resolved_at: string | null;
    };
    expect(row.slug).toBe("slug-a");
    expect(row.reason).toBe("slug_collision");
    expect(row.error_message).toBe("dup key value");
    expect(row.resolved_at).toBe(null);
  });

  it("repeat block with same error returns isNew=false (idempotent, no log)", () => {
    const db = getLocal();
    const blocker = new ProjectBlocker(db);
    blocker.loadBlocked();

    expect(blocker.recordBlock("proj_A", "slug-a", "slug_collision", "dup")).toBe(true);
    expect(blocker.recordBlock("proj_A", "slug-a", "slug_collision", "dup")).toBe(false);
  });

  it("repeat block with changed error returns isNew=true and updates error_message", () => {
    const db = getLocal();
    const blocker = new ProjectBlocker(db);
    blocker.loadBlocked();

    expect(blocker.recordBlock("proj_A", "slug-a", "slug_collision", "err1")).toBe(true);
    expect(blocker.recordBlock("proj_A", "slug-a", "slug_collision", "err2")).toBe(true);
    const row = db.query("SELECT error_message FROM projects_blocked WHERE proj_id=?").get("proj_A") as {
      error_message: string;
    };
    expect(row.error_message).toBe("err2");
  });

  it("re-block after resolve returns isNew=true and clears resolved_at", () => {
    const db = getLocal();
    const blocker = new ProjectBlocker(db);
    blocker.loadBlocked();

    blocker.recordBlock("proj_A", "slug-a", "slug_collision", "err1");
    db.query("UPDATE projects_blocked SET resolved_at=? WHERE proj_id=?")
      .run(new Date().toISOString(), "proj_A");
    blocker.loadBlocked(); // simulate restart
    expect(blocker.isBlocked("proj_A")).toBe(false);

    const isNew = blocker.recordBlock("proj_A", "slug-a", "slug_collision", "err1");
    expect(isNew).toBe(true);
    expect(blocker.isBlocked("proj_A")).toBe(true);
    const row = db.query("SELECT resolved_at FROM projects_blocked WHERE proj_id=?").get("proj_A") as {
      resolved_at: string | null;
    };
    expect(row.resolved_at).toBe(null);
  });
});
