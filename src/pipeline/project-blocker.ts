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

  /**
   * Record (or refresh) a block for a project. Returns true iff this is a newly
   * recorded incident — caller should emit a structured log only when true, to
   * avoid spam from the 5s ship cadence. "New" means: no open row existed, or
   * the error_message has changed, or the previous row had been resolved.
   */
  recordBlock(projId: string, slug: string, reason: BlockReason, errorMessage: string): boolean {
    const existing = this.db
      .query("SELECT error_message, resolved_at FROM projects_blocked WHERE proj_id = ?")
      .get(projId) as { error_message: string; resolved_at: string | null } | null;

    const isRepeatSame =
      existing !== null &&
      existing.resolved_at === null &&
      existing.error_message === errorMessage;
    if (isRepeatSame) {
      this.inMemory.add(projId); // defensive — should already be in
      return false;
    }

    const now = new Date().toISOString();
    this.db
      .query(
        `INSERT INTO projects_blocked (proj_id, slug, reason, error_message, first_seen_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, NULL)
         ON CONFLICT(proj_id) DO UPDATE SET
           slug = excluded.slug,
           reason = excluded.reason,
           error_message = excluded.error_message,
           first_seen_at = excluded.first_seen_at,
           resolved_at = NULL`
      )
      .run(projId, slug, reason, errorMessage, now);

    this.inMemory.add(projId);
    return true;
  }
}
