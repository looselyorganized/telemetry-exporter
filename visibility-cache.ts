/**
 * Caches GitHub repo visibility (public vs private).
 * Fetches all repos in one `gh repo list` call, then caches locally.
 */

import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

type Visibility = "public" | "private";

const CACHE_FILE = join(
  dirname(new URL(import.meta.url).pathname),
  ".visibility-cache.json"
);

let cache: Record<string, Visibility> = {};
let ghRepoMap: Record<string, boolean> | null = null;

export function loadVisibilityCache(): void {
  try {
    if (existsSync(CACHE_FILE)) {
      cache = JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
    }
  } catch {
    cache = {};
  }
}

function saveCache(): void {
  try {
    writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch {
    // Best-effort persistence -- non-critical if disk write fails
  }
}

/**
 * Fetch all repos from GitHub in one call.
 * Maps repo name to isPrivate. Only runs once per session.
 */
function ensureGhRepoMap(): void {
  if (ghRepoMap !== null) return;

  ghRepoMap = {};
  try {
    const output = execSync(
      `gh repo list --limit 200 --json name,isPrivate -q '.[] | "\\(.name) \\(.isPrivate)"'`,
      { encoding: "utf-8", timeout: 15000, stdio: ["pipe", "pipe", "pipe"] }
    ).trim();

    if (output) {
      for (const line of output.split("\n")) {
        const [name, isPrivate] = line.trim().split(" ");
        if (name) {
          ghRepoMap[name] = isPrivate === "true";
        }
      }
    }
    console.log(`  Loaded ${Object.keys(ghRepoMap).length} repos from GitHub`);
  } catch {
    console.warn(
      "  Warning: Could not fetch GitHub repos. Defaulting to private."
    );
  }
}

/**
 * Resolve a project name to its visibility.
 * Uses the cached GitHub repo list for fast lookups.
 * Defaults to "classified" (safer) when a project is not found on GitHub.
 */
export function getVisibility(projectName: string): Visibility {
  if (cache[projectName]) return cache[projectName];

  ensureGhRepoMap();

  const isPublic = ghRepoMap![projectName] === false;
  const visibility: Visibility = isPublic ? "public" : "private";

  cache[projectName] = visibility;
  saveCache();
  return visibility;
}
