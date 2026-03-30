/**
 * Project name resolution for ~/.claude/projects/ directory names.
 *
 * Only processes directories whose encoded CWD starts with a known
 * org root prefix + "-". This prevents:
 *   1. Parent CWD misattribution (org root without trailing repo name)
 *   2. Duplicate counting from dirs outside the org root that resolve to the
 *      same slug (e.g. projects/nexus vs projects/looselyorganized/nexus)
 */

import { readdirSync } from "fs";
import { join } from "path";

import { isDirectory } from "../utils";
import { resolveProjId, normalizeFsPath, PROJECT_ROOT } from "./slug-resolver";
import type { ProjectResolver } from "./resolver";

// ─── Constants ──────────────────────────────────────────────────────────────

const LEGACY_ROOT = normalizeFsPath("/Users/bigviking/Documents/github/projects/looselyorganized");
const ENCODED_ROOTS = [PROJECT_ROOT, LEGACY_ROOT].map((r) => r.replace(/\//g, "-"));

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Read subdirectory names from PROJECT_ROOT and archive/, sorted longest-first for prefix matching. */
function readProjectDirs(): string[] {
  const dirs = new Set<string>();
  for (const root of [PROJECT_ROOT, join(PROJECT_ROOT, "archive")]) {
    try {
      for (const d of readdirSync(root)) {
        if (isDirectory(join(root, d))) dirs.add(d);
      }
    } catch {
      // root doesn't exist or isn't readable
    }
  }
  return [...dirs].sort((a, b) => b.length - a.length);
}

// ─── Project name resolution ────────────────────────────────────────────────

/**
 * Resolve an encoded ~/.claude/projects/ directory name to a project name.
 *
 * Only matches directories under the canonical org root prefix.
 * Returns null for the org root itself, directories outside the org root,
 * or directories that don't match any repo on disk.
 */
export function resolveProjectName(encodedDirName: string): string | null {
  const lowerEncoded = encodedDirName.toLowerCase();

  for (const encodedRoot of ENCODED_ROOTS) {
    const lowerRoot = encodedRoot.toLowerCase();
    if (!lowerEncoded.startsWith(lowerRoot + "-")) continue;

    const lowerRemainder = encodedDirName
      .slice(encodedRoot.length + 1)
      .toLowerCase();

    for (const dir of readProjectDirs()) {
      const lowerDir = dir.toLowerCase();
      if (lowerRemainder === lowerDir || lowerRemainder.startsWith(lowerDir + "-")) {
        return dir;
      }
    }
  }

  return null;
}

/**
 * Resolve an encoded ~/.claude/projects/ directory name to a projId.
 *
 * When a ProjectResolver is provided:
 * 1. Decode encoded path → plain directory name via resolveProjectName()
 * 2. Look up plain name in resolver (covers disk, Supabase, org-root)
 * 3. Fallback: look up encoded name directly in resolver (covers legacy mapping)
 *
 * Without a resolver, falls back to original two-step resolution.
 */
export function resolveProjIdForDir(
  encodedDirName: string,
  resolver?: ProjectResolver
): string | null {
  const projectName = resolveProjectName(encodedDirName);

  if (resolver) {
    // Try plain name first (disk + Supabase + org-root)
    if (projectName) {
      const resolved = resolver.resolve(projectName);
      if (resolved) return resolved.projId;
    }
    // Try encoded name (legacy .project-mapping.json entries)
    const legacyResolved = resolver.resolve(encodedDirName);
    if (legacyResolved) return legacyResolved.projId;
    return null;
  }

  // No resolver — resolve via git remote
  if (projectName) {
    return resolveProjId(join(PROJECT_ROOT, projectName));
  }
  return null;
}
