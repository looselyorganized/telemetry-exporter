import type { Database } from "bun:sqlite";

export type BlockReason = "slug_collision" | "fk_cascade";

/**
 * Persistent, in-memory-cached registry of projects that cannot ship to Supabase.
 *
 * When a projects-table insert hits a unique-constraint violation (slug collision)
 * or a dependent-table insert hits an FK violation, recordBlock() persists the
 * failure and adds the proj_id to a hot-path Set. Enqueue paths and the shipper
 * consult isBlocked() to skip writes for blocked projects until a human resolves
 * the block (sets resolved_at) and the daemon restarts.
 */
export class ProjectBlocker {
  private readonly inMemory = new Set<string>();

  constructor(private readonly db: Database) {}

  /** Populate the in-memory Set from persisted open blocks. Call once at daemon startup. */
  loadBlocked(): void {
    this.inMemory.clear();
    const rows = this.db
      .query("SELECT proj_id FROM projects_blocked WHERE resolved_at IS NULL")
      .all() as Array<{ proj_id: string }>;
    for (const row of rows) this.inMemory.add(row.proj_id);
  }

  /** O(1) hot-path check. */
  isBlocked(projId: string): boolean {
    return this.inMemory.has(projId);
  }

  /** Snapshot of currently-blocked proj_ids. Mutations to the returned Set are isolated. */
  getBlocked(): Set<string> {
    return new Set(this.inMemory);
  }
}
