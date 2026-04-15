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
