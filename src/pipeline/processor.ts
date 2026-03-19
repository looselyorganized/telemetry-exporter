import { Database } from "bun:sqlite";
import type { ProjectResolver } from "../project/resolver";
import type { LogEntry } from "../parsers";
import { enqueue, enqueueArchive, addKnownProject, getKnownProjectIds } from "../db/local";

export class Processor {
  private resolver: ProjectResolver;
  private db: Database;
  private knownProjects: Set<string>;

  constructor(resolver: ProjectResolver, db: Database) {
    this.resolver = resolver;
    this.db = db;
    this.knownProjects = new Set<string>();
  }

  /** Load known_projects from SQLite into in-memory Set. */
  loadKnownProjects(): void {
    const ids = getKnownProjectIds();
    for (const id of ids) {
      this.knownProjects.add(id);
    }
  }

  /** Process log entries: filter, register projects, enqueue events + archive. */
  processEvents(entries: LogEntry[]): void {
    this.db.transaction(() => {
      // Step 1: Resolve all entries — skip those that don't resolve
      const resolved: Array<{ entry: LogEntry; projId: string; slug: string }> = [];
      for (const entry of entries) {
        if (!entry.project) continue;
        const result = this.resolver.resolve(entry.project);
        if (result === null) continue;
        resolved.push({ entry, projId: result.projId, slug: result.slug });
      }

      // Step 2: Register unknown projects
      for (const { projId, slug } of resolved) {
        if (!this.knownProjects.has(projId)) {
          enqueue("projects", { id: projId, slug });
          addKnownProject(projId, slug);
          this.knownProjects.add(projId);
        }
      }

      // Step 3: Enqueue each event
      for (const { entry, projId } of resolved) {
        const timestamp = entry.parsedTimestamp?.toISOString() ?? null;
        const eventPayload = {
          project_id: projId,
          event_type: entry.eventType,
          event_text: entry.eventText,
          timestamp,
          branch: entry.branch,
          emoji: entry.emoji,
        };
        enqueue("events", eventPayload);

        // Step 5: Archive each event with a content hash
        const hashInput = `${projId}\0${entry.eventType}\0${entry.eventText}\0${timestamp ?? ""}`;
        const hasher = new Bun.CryptoHasher("sha256");
        hasher.update(hashInput);
        const contentHash = hasher.digest("hex");
        enqueueArchive("event", JSON.stringify(eventPayload), contentHash);
      }

      // Step 4: Enqueue project activity updates (one per project, using latest timestamp)
      const latestByProject = new Map<string, string>();
      for (const { entry, projId } of resolved) {
        if (entry.parsedTimestamp === null) continue;
        const ts = entry.parsedTimestamp.toISOString();
        const existing = latestByProject.get(projId);
        if (!existing || ts > existing) {
          latestByProject.set(projId, ts);
        }
      }

      for (const [projId, lastActive] of latestByProject) {
        enqueue("projects", { id: projId, last_active: lastActive });
      }
    })();
  }
}
