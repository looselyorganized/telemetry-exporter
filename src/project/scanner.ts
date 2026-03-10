/**
 * JSONL session scanner for per-project token aggregation.
 * Reads session JSONL files from ~/.claude/projects/ and aggregates
 * token usage by project, date, and model.
 *
 * Only processes directories whose encoded CWD starts with a known
 * org root prefix + "-". This prevents:
 *   1. Parent CWD misattribution (org root without trailing repo name)
 *   2. Duplicate counting from dirs outside the org root that resolve to the
 *      same slug (e.g. projects/nexus vs projects/looselyorganized/nexus)
 */

import { readdirSync, readFileSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";

import { resolveProjId, loadLegacyMapping } from "./slug-resolver";

// ─── Constants ──────────────────────────────────────────────────────────────

const PROJECTS_DIR = join(homedir(), ".claude", "projects");
const PROJECT_ROOT = "/Users/bigviking/Documents/github/projects/lo";
const LEGACY_ROOT = "/Users/bigviking/Documents/github/projects/looselyorganized";
const ENCODED_ROOTS = [PROJECT_ROOT, LEGACY_ROOT].map((r) => r.replace(/\//g, "-"));

// ─── Types ──────────────────────────────────────────────────────────────────

/** proj_id -> date -> { model: totalTokens } */
export type ProjectTokenMap = Map<string, Map<string, Record<string, number>>>;

interface JsonlFile {
  fullPath: string;
  dedupKey: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Read subdirectory names from PROJECT_ROOT, sorted longest-first for prefix matching. */
function readProjectDirs(): string[] {
  try {
    return readdirSync(PROJECT_ROOT)
      .filter((d) => isDirectory(join(PROJECT_ROOT, d)))
      .sort((a, b) => b.length - a.length);
  } catch {
    return [];
  }
}

/** Get or create a value in a Map, inserting `defaultValue()` if the key is absent. */
function getOrCreate<K, V>(map: Map<K, V>, key: K, defaultValue: () => V): V {
  let value = map.get(key);
  if (value === undefined) {
    value = defaultValue();
    map.set(key, value);
  }
  return value;
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
 * Resolve an encoded ~/.claude/projects/ directory name to a proj_id.
 *
 * Two-step resolution:
 * 1. Live repos: resolveProjectName() → resolveProjId() from .lo/PROJECT.md
 * 2. Legacy/orphan dirs: falls back to static .project-mapping.json
 */
export function resolveProjIdForDir(encodedDirName: string): string | null {
  // Try live repo path first
  const projectName = resolveProjectName(encodedDirName);
  if (projectName) {
    const projId = resolveProjId(join(PROJECT_ROOT, projectName));
    if (projId) return projId;
  }

  // Fall back to legacy mapping for orphan/renamed directories
  return loadLegacyMapping().get(encodedDirName) ?? null;
}

// ─── JSONL file discovery ───────────────────────────────────────────────────

/**
 * Find all .jsonl files in a project directory: top-level session files
 * and subagent session files nested under <session-uuid>/subagents/.
 */
function discoverJsonlFiles(dirPath: string): JsonlFile[] {
  const files: JsonlFile[] = [];

  let entries: string[];
  try {
    entries = readdirSync(dirPath);
  } catch {
    return files;
  }

  for (const entry of entries) {
    if (entry.endsWith(".jsonl")) {
      files.push({ fullPath: join(dirPath, entry), dedupKey: entry });
      continue;
    }

    try {
      const subDir = join(dirPath, entry, "subagents");
      for (const sf of readdirSync(subDir)) {
        if (sf.endsWith(".jsonl")) {
          files.push({
            fullPath: join(subDir, sf),
            dedupKey: join(entry, "subagents", sf),
          });
        }
      }
    } catch {
      // Not a session directory or no subagents
    }
  }

  return files;
}

// ─── Usage record extraction ────────────────────────────────────────────────

/**
 * Extract usage records from a single JSONL file and accumulate them
 * into the result map. Returns the number of records extracted.
 *
 * Fast-filters lines by "usage" substring before parsing JSON.
 * Deduplicates by requestId to avoid counting streaming chunks.
 */
function extractUsageRecords(
  filePath: string,
  projId: string,
  result: ProjectTokenMap
): number {
  const content = readFileSync(filePath, "utf-8");
  const seenRequestIds = new Set<string>();
  let recordCount = 0;

  for (const line of content.split("\n")) {
    if (!line.includes('"usage"')) continue;

    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    const usage = parsed?.message?.usage;
    if (!usage) continue;

    const requestId = parsed.requestId;
    if (requestId) {
      if (seenRequestIds.has(requestId)) continue;
      seenRequestIds.add(requestId);
    }

    const model = parsed.message?.model;
    const timestamp = parsed.timestamp;
    if (!model || !timestamp) continue;

    const tokens =
      (usage.input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0) +
      (usage.output_tokens ?? 0);

    if (tokens === 0) continue;

    const date = timestamp.substring(0, 10);
    const dateMap = getOrCreate(result, projId, () => new Map());
    const modelMap = getOrCreate(dateMap, date, () => ({}));
    modelMap[model] = (modelMap[model] ?? 0) + tokens;

    recordCount++;
  }

  return recordCount;
}

// ─── Main scanner ───────────────────────────────────────────────────────────

/**
 * Scan all JSONL session files and aggregate token usage
 * by project, date, and model.
 */
export function scanProjectTokens(): ProjectTokenMap {
  const result: ProjectTokenMap = new Map();

  let projectDirs: string[];
  try {
    projectDirs = readdirSync(PROJECTS_DIR);
  } catch {
    console.warn("  Could not read projects directory:", PROJECTS_DIR);
    return result;
  }

  let totalFiles = 0;
  let totalRecords = 0;
  let skippedFiles = 0;
  let skippedDirs = 0;
  let dedupedFiles = 0;

  const seenFilesByProjId = new Map<string, Set<string>>();

  for (const dirName of projectDirs) {
    const dirPath = join(PROJECTS_DIR, dirName);
    if (!isDirectory(dirPath)) continue;

    const projId = resolveProjIdForDir(dirName);
    if (!projId) {
      skippedDirs++;
      continue;
    }

    const seenFiles = getOrCreate(seenFilesByProjId, projId, () => new Set());
    const filePaths = discoverJsonlFiles(dirPath);

    for (const { fullPath, dedupKey } of filePaths) {
      if (seenFiles.has(dedupKey)) {
        dedupedFiles++;
        continue;
      }
      seenFiles.add(dedupKey);
      totalFiles++;

      try {
        totalRecords += extractUsageRecords(fullPath, projId, result);
      } catch {
        skippedFiles++;
      }
    }
  }

  const parts = [`  Scanned ${totalFiles} JSONL files, ${totalRecords} usage records`];
  if (skippedDirs > 0) parts.push(`${skippedDirs} dirs skipped (non-org-root)`);
  if (dedupedFiles > 0) parts.push(`${dedupedFiles} deduped`);
  if (skippedFiles > 0) parts.push(`${skippedFiles} errors`);
  console.log(parts.join(", "));

  return result;
}

// ─── Per-project lifetime totals ────────────────────────────────────────────

/** Compute total lifetime tokens per project (keyed by proj_id) from the token map. */
export function computeTokensByProject(
  tokenMap: ProjectTokenMap
): Record<string, number> {
  const totals: Record<string, number> = {};

  for (const [project, dateMap] of tokenMap) {
    let total = 0;
    for (const [, modelMap] of dateMap) {
      for (const tokens of Object.values(modelMap)) {
        total += tokens;
      }
    }
    totals[project] = total;
  }

  return totals;
}
