/**
 * Session registry — maps OTel session.id → project identity.
 *
 * OTel's session.id is the same UUID as the JSONL filename in
 * ~/.claude/projects/<encoded-dir>/<uuid>.jsonl. This module scans
 * those directories to build session→project mappings without
 * reading any file contents.
 *
 * Mappings are immutable once registered (INSERT OR IGNORE).
 * Directory renames cannot break attribution after first registration.
 */

import { readdirSync } from "fs";
import { homedir } from "os";
import { join, basename } from "path";
import { isDirectory } from "../utils";
import { resolveProjIdForDir, resolveProjectName } from "../project/scanner";
import { PROJECT_ROOT } from "../project/slug-resolver";
import { upsertSession, getSession, enqueueArchive } from "../db/local";
import type { SessionRow } from "../db/local";
import type { ProjectResolver } from "../project/resolver";

const PROJECTS_DIR = join(homedir(), ".claude", "projects");

// ─── UUID pattern ───────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}

// ─── CWD resolution ─────────────────────────────────────────────────────────

/**
 * Resolve an encoded ~/.claude/projects/ directory name to a CWD path.
 * Uses resolveProjectName to find the actual project directory name,
 * then constructs the full path under PROJECT_ROOT.
 * Falls back to the encoded name if resolution fails.
 */
function resolveEncodedDirToCwd(encodedName: string): string {
  const projectName = resolveProjectName(encodedName);
  if (projectName) return join(PROJECT_ROOT, projectName);
  return encodedName; // fallback: store encoded name as-is
}

// ─── Registry operations ────────────────────────────────────────────────────

/**
 * Build the session registry by scanning ~/.claude/projects/.
 * For each encoded directory that resolves to a proj_id, list all
 * .jsonl files and register their UUIDs as session→project mappings.
 *
 * Returns the number of new sessions registered.
 */
export function buildSessionRegistry(
  resolver: ProjectResolver,
  projectsDir: string = PROJECTS_DIR
): number {
  let dirs: string[];
  try {
    dirs = readdirSync(projectsDir);
  } catch {
    return 0;
  }

  let registered = 0;

  for (const encodedDir of dirs) {
    const dirPath = join(projectsDir, encodedDir);
    if (!isDirectory(dirPath)) continue;

    const projId = resolveProjIdForDir(encodedDir, resolver);
    if (!projId) continue;

    const cwd = resolveEncodedDirToCwd(encodedDir);

    // List .jsonl files — filename (minus extension) is the session UUID
    let entries: string[];
    try {
      entries = readdirSync(dirPath);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue;
      const sessionId = basename(entry, ".jsonl");
      if (!isUuid(sessionId)) continue;

      if (!getSession(sessionId)) {
        upsertSession(sessionId, projId, cwd);
        archiveSessionMapping(sessionId, projId, cwd);
        registered++;
      }
    }

    // Scan subagent directories: <session-uuid>/subagents/<uuid>.jsonl
    for (const entry of entries) {
      if (entry.endsWith(".jsonl")) continue;
      try {
        const subDir = join(dirPath, entry, "subagents");
        for (const sf of readdirSync(subDir)) {
          if (!sf.endsWith(".jsonl")) continue;
          const subSessionId = basename(sf, ".jsonl");
          if (!isUuid(subSessionId)) continue;
          if (!getSession(subSessionId)) {
            upsertSession(subSessionId, projId, cwd);
            archiveSessionMapping(subSessionId, projId, cwd);
            registered++;
          }
        }
      } catch {
        // Not a session directory or no subagents
      }
    }
  }

  return registered;
}

/**
 * Look up a session by ID. Returns {proj_id, cwd} or null.
 */
export function lookupSession(sessionId: string): SessionRow | null {
  return getSession(sessionId);
}

/**
 * Register a single session→project mapping. Immutable (first write wins).
 * Also archives to Supabase via archive queue.
 */
export function registerSession(
  sessionId: string,
  projId: string,
  cwd: string
): void {
  upsertSession(sessionId, projId, cwd);
  archiveSessionMapping(sessionId, projId, cwd);
}

/** Archive a session mapping to Supabase via the archive queue. */
function archiveSessionMapping(sessionId: string, projId: string, cwd: string): void {
  const payload = JSON.stringify({ session_id: sessionId, proj_id: projId, cwd });
  enqueueArchive("session_mapping", payload, sessionId);
}

/**
 * Refresh the registry by re-scanning for new sessions.
 * Same as buildSessionRegistry but only inserts new ones (INSERT OR IGNORE).
 * Returns the number of new sessions found.
 */
export function refreshRegistry(
  resolver: ProjectResolver,
  projectsDir: string = PROJECTS_DIR
): number {
  return buildSessionRegistry(resolver, projectsDir);
}
