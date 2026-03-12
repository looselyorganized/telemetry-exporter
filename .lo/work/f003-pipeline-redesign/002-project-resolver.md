---
status: pending
feature_id: "f003"
feature: "Pipeline Redesign"
phase: 2
---

# Pipeline Redesign — Phase 2: ProjectResolver

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate the three independent dirName → projId resolution paths into a single `ProjectResolver` class shared by daemon, verify pipeline, and scanner.

**Architecture:** `ProjectResolver` has a synchronous `resolve()` (in-memory, never awaits — safe for the 250ms watcher loop) and an async `refresh()` (rebuilds maps from disk + Supabase). Resolution sources in priority order: disk, Supabase `local_names`, hardcoded org-root, legacy `.project-mapping.json`.

**Tech Stack:** Bun, TypeScript, Supabase JS client, bun:test

**Spec:** `.lo/work/f003-pipeline-redesign/spec.md` — Section 1

**Depends on:** Phase 1 complete (sync.ts removed, db/ modules in place)

---

## File Structure

### New files

```
src/project/resolver.ts                # ProjectResolver class
src/__tests__/project-resolver.test.ts # Tests
```

### Modified files

```
bin/daemon.ts             # Replace refreshMaps/toProjId/toSlug with ProjectResolver
src/verify/local-reader.ts  # Receive ProjectResolver instead of building own projIdMap
bin/dashboard.ts          # Instantiate ProjectResolver, pass to readAllLocal
src/project/scanner.ts    # Use ProjectResolver.resolve() instead of resolveProjIdForDir
```

---

## Chunk 1: ProjectResolver

### Task 1: Create `ProjectResolver` class (TDD)

**Files:**
- Create: `src/__tests__/project-resolver.test.ts`
- Create: `src/project/resolver.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/__tests__/project-resolver.test.ts
import { describe, test, expect, beforeEach } from "bun:test";
import { mock } from "bun:test";

// Mock Supabase for tests that call refresh()
const mockProjectRows: any[] = [];

mock.module("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => ({
      select: () => ({
        data: table === "projects" ? mockProjectRows : [],
        error: null,
      }),
    }),
  }),
}));

const { initSupabase, getSupabase } = await import("../db/client");
initSupabase("http://fake", "fake-key");

const { ProjectResolver } = await import("../project/resolver");

describe("ProjectResolver", () => {
  let resolver: InstanceType<typeof ProjectResolver>;

  beforeEach(() => {
    resolver = new ProjectResolver();
    mockProjectRows.length = 0;
  });

  describe("resolve()", () => {
    test("returns null for unknown directory", () => {
      expect(resolver.resolve("unknown-dir")).toBeNull();
    });

    test("resolves org-root names", async () => {
      await resolver.refresh(getSupabase());
      const result = resolver.resolve("looselyorganized");
      expect(result).not.toBeNull();
      expect(result!.projId).toBe("proj_org-root");
      expect(result!.slug).toBe("org-root");
    });

    test("resolves org-root 'lo' alias", async () => {
      await resolver.refresh(getSupabase());
      const result = resolver.resolve("lo");
      expect(result).not.toBeNull();
      expect(result!.projId).toBe("proj_org-root");
    });
  });

  describe("refresh()", () => {
    test("loads projects from disk", async () => {
      await resolver.refresh(getSupabase());
      const stats = resolver.stats();
      // At minimum, org-root should be loaded
      expect(stats.total).toBeGreaterThanOrEqual(2);
    });

    test("merges Supabase local_names for historical resolution", async () => {
      // Simulate a project with historical local name
      mockProjectRows.push({
        id: "proj_test123",
        content_slug: "lorf-bot",
        local_names: ["lo-concierge"],
      });

      await resolver.refresh(getSupabase());
      const result = resolver.resolve("lo-concierge");
      expect(result).not.toBeNull();
      expect(result!.projId).toBe("proj_test123");
    });

    test("lorf-bot scenario: both current and historical names resolve to same project", async () => {
      // This is the motivating bug: lorf-bot exists on disk, lo-concierge is the old name.
      // Both should resolve to the same projId.
      // Disk has "lorf-bot" → proj_fe8141ea (via project.yml)
      // Supabase has local_names: ["lo-concierge"] for the same project
      mockProjectRows.push({
        id: "proj_fe8141ea",
        content_slug: "lorf-bot",
        local_names: ["lo-concierge"],
      });

      await resolver.refresh(getSupabase());

      // Disk name resolves (if lorf-bot is a real dir in PROJECT_ROOT)
      const diskResult = resolver.resolve("lorf-bot");
      const historyResult = resolver.resolve("lo-concierge");

      // Historical name always resolves via Supabase local_names
      expect(historyResult).not.toBeNull();
      expect(historyResult!.projId).toBe("proj_fe8141ea");

      // If disk name also resolves, they must agree
      if (diskResult) {
        expect(diskResult.projId).toBe(historyResult!.projId);
      }
    });

    test("disk wins over Supabase on conflicts", async () => {
      // Supabase claims "telemetry-exporter" maps to a different projId
      // than what's on disk. Disk (ground truth) must win.
      await resolver.refresh(getSupabase());
      const diskResult = resolver.resolve("telemetry-exporter");

      if (diskResult) {
        // Now add a Supabase entry with a conflicting projId
        mockProjectRows.push({
          id: "proj_imposter",
          content_slug: "telemetry-exporter",
          local_names: [],
        });

        // Re-refresh — disk should still win
        await resolver.refresh(getSupabase());
        const afterResult = resolver.resolve("telemetry-exporter");
        expect(afterResult!.projId).toBe(diskResult.projId);
        expect(afterResult!.projId).not.toBe("proj_imposter");
      }
    });
  });

  describe("entries()", () => {
    test("returns all known mappings", async () => {
      await resolver.refresh(getSupabase());
      const allEntries = [...resolver.entries()];
      expect(allEntries.length).toBeGreaterThanOrEqual(2);

      // Each entry has dirName, projId, and slug
      for (const [dirName, resolved] of allEntries) {
        expect(typeof dirName).toBe("string");
        expect(resolved.projId).toBeDefined();
        expect(resolved.slug).toBeDefined();
      }
    });

    test("includes supplemental projects not on disk", async () => {
      mockProjectRows.push({
        id: "proj_remote_only",
        content_slug: "remote-project",
        local_names: ["old-remote-name"],
      });

      await resolver.refresh(getSupabase());
      const allEntries = new Map(resolver.entries());

      // Supabase-only entries should appear in entries()
      expect(allEntries.has("remote-project")).toBe(true);
      expect(allEntries.has("old-remote-name")).toBe(true);
    });
  });

  describe("stats()", () => {
    test("returns resolution source breakdown", async () => {
      await resolver.refresh(getSupabase());
      const stats = resolver.stats();
      expect(stats).toHaveProperty("total");
      expect(stats).toHaveProperty("fromDisk");
      expect(stats).toHaveProperty("fromSupabase");
      expect(stats).toHaveProperty("fromLegacy");
      expect(stats.total).toBe(
        stats.fromDisk + stats.fromSupabase + stats.fromLegacy
      );
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/__tests__/project-resolver.test.ts
```

Expected: FAIL — `ProjectResolver` not found in `../project/resolver`.

- [ ] **Step 3: Implement `src/project/resolver.ts`**

```typescript
// src/project/resolver.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { join } from "path";
import {
  buildSlugMap,
  clearSlugCache,
  resolveProjId,
  clearProjIdCache,
  loadLegacyMapping,
  PROJECT_ROOT,
} from "./slug-resolver";

export interface ResolvedProject {
  projId: string;
  slug: string;
}

interface ResolutionStats {
  total: number;
  fromDisk: number;
  fromSupabase: number;
  fromLegacy: number;
}

const ORG_ROOT_ID = "proj_org-root";
const ORG_ROOT_NAMES = ["looselyorganized", "lo"];

/**
 * Single resolution authority for dirName → projId mapping.
 *
 * Consolidates all resolution paths: disk, Supabase local_names,
 * org-root hardcode, and legacy .project-mapping.json.
 *
 * resolve() is synchronous — the 250ms watcher loop calls it and must never await.
 * refresh() is async — rebuilds maps from disk + Supabase. Called at startup
 * and periodically (every 60 cycles / 5 minutes).
 */
export class ProjectResolver {
  private dirToProject = new Map<string, ResolvedProject>();
  private resolutionStats: ResolutionStats = {
    total: 0,
    fromDisk: 0,
    fromSupabase: 0,
    fromLegacy: 0,
  };

  /**
   * Synchronous, in-memory only. Never hits network or disk.
   */
  resolve(dirName: string): ResolvedProject | null {
    return this.dirToProject.get(dirName) ?? null;
  }

  /**
   * Async. Rebuilds maps from disk + Supabase.
   * Resolution sources in priority order:
   * 1. Disk (ground truth) — reads project.yml/PROJECT.md from each subdirectory
   * 2. Supabase local_names — historical directory names from the projects table
   * 3. Org-root hardcode — ["looselyorganized", "lo"] → proj_org-root
   * 4. Legacy .project-mapping.json — static fallback for orphaned directories
   *
   * Disk always wins on conflicts.
   */
  async refresh(supabase: SupabaseClient): Promise<void> {
    const newMap = new Map<string, ResolvedProject>();
    let fromDisk = 0;
    let fromSupabase = 0;
    let fromLegacy = 0;

    // 1. Disk — ground truth
    clearSlugCache();
    clearProjIdCache();
    const slugMap = buildSlugMap();

    for (const [dirName, slug] of slugMap) {
      const projId = resolveProjId(join(PROJECT_ROOT, dirName));
      if (projId) {
        newMap.set(dirName, { projId, slug });
        fromDisk++;
      }
    }

    // 2. Supabase local_names — historical directory names
    try {
      const { data: projects } = await supabase
        .from("projects")
        .select("id, content_slug, local_names");

      for (const proj of projects ?? []) {
        const projId = proj.id as string;
        const slug = (proj.content_slug as string) ?? projId;

        // Add content_slug as a resolvable name (if not already from disk)
        if (slug && !newMap.has(slug)) {
          newMap.set(slug, { projId, slug });
          fromSupabase++;
        }

        // Add each local_name as a resolvable name (if not already from disk)
        for (const name of (proj.local_names as string[]) ?? []) {
          if (!newMap.has(name)) {
            newMap.set(name, { projId, slug });
            fromSupabase++;
          }
        }
      }
    } catch {
      // Supabase unreachable — continue with disk + hardcoded sources
    }

    // 3. Org-root hardcode
    for (const name of ORG_ROOT_NAMES) {
      if (!newMap.has(name)) {
        newMap.set(name, { projId: ORG_ROOT_ID, slug: "org-root" });
        // Count org-root under disk since it's a hardcoded local source
        fromDisk++;
      }
    }

    // 4. Legacy .project-mapping.json
    const legacyMap = loadLegacyMapping();
    for (const [encodedName, projId] of legacyMap) {
      if (!newMap.has(encodedName)) {
        newMap.set(encodedName, { projId, slug: encodedName });
        fromLegacy++;
      }
    }

    this.dirToProject = newMap;
    this.resolutionStats = {
      total: newMap.size,
      fromDisk,
      fromSupabase,
      fromLegacy,
    };
  }

  /**
   * Iterate all known directory name → project mappings.
   * Includes disk, Supabase, org-root, and legacy entries.
   * Used by local-reader to enumerate all resolvable projects.
   */
  entries(): IterableIterator<[string, ResolvedProject]> {
    return this.dirToProject.entries();
  }

  /** Resolution stats for boot logging. */
  stats(): ResolutionStats {
    return { ...this.resolutionStats };
  }
}
```

- [ ] **Step 4: Run tests**

```bash
bun test src/__tests__/project-resolver.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Run full test suite**

```bash
bun test
```

Expected: all tests pass (existing tests unaffected — ProjectResolver is additive).

- [ ] **Step 6: Commit**

```bash
git add src/project/resolver.ts src/__tests__/project-resolver.test.ts
git commit -m "feat: add ProjectResolver — single resolution authority for dirName → projId"
```

---

### Task 2: Update `bin/daemon.ts` to use ProjectResolver

**Files:**
- Modify: `bin/daemon.ts`

This is the largest consumer change. Replace:
- `slugMap`, `projIdMap` module state → `resolver` instance
- `refreshMaps()` → `resolver.refresh(getSupabase())`
- `toProjId(dirName)` → `resolver.resolve(dirName)?.projId ?? null`
- `toSlug(dirName)` → `resolver.resolve(dirName)?.slug ?? null`
- Remove `ORG_ROOT_ID`, `ORG_ROOT_NAMES` (now in ProjectResolver)

- [ ] **Step 1: Update imports**

Replace slug-resolver imports (line 58):

```typescript
// Before:
import { buildSlugMap, clearSlugCache, resolveProjId, clearProjIdCache, PROJECT_ROOT } from "../src/project/slug-resolver";

// After:
import { ProjectResolver } from "../src/project/resolver";
import { PROJECT_ROOT } from "../src/project/slug-resolver";
```

Keep `PROJECT_ROOT` import — still needed for JSONL scanning.

- [ ] **Step 2: Replace module state**

```typescript
// Remove:
let slugMap: Map<string, string> = new Map();
let projIdMap: Map<string, string> = new Map();
const ORG_ROOT_ID = "proj_org-root";
const ORG_ROOT_NAMES = ["looselyorganized", "lo"];

// Add:
const resolver = new ProjectResolver();
```

- [ ] **Step 3: Replace `refreshMaps()`**

```typescript
// Remove the entire refreshMaps() function. Replace with:
async function refreshResolver(): Promise<void> {
  await resolver.refresh(getSupabase());
  const stats = resolver.stats();
  console.log(
    `  Project maps: ${stats.total} projects mapped (disk: ${stats.fromDisk}, supabase: ${stats.fromSupabase}, legacy: ${stats.fromLegacy})`
  );
}
```

Update all call sites: `refreshMaps()` → `refreshResolver()`.

- [ ] **Step 4: Replace `toProjId()` and `toSlug()`**

```typescript
// Replace:
function toProjId(dirName: string): string | null {
  return projIdMap.get(dirName) ?? null;
}

function toSlug(dirName: string): string | null {
  return slugMap.get(dirName) ?? null;
}

// With:
function toProjId(dirName: string): string | null {
  return resolver.resolve(dirName)?.projId ?? null;
}

function toSlug(dirName: string): string | null {
  return resolver.resolve(dirName)?.slug ?? null;
}
```

- [ ] **Step 5: Run tests**

```bash
bun test
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add bin/daemon.ts
git commit -m "refactor: daemon uses ProjectResolver for dirName → projId resolution"
```

---

### Task 3: Update verify pipeline (local-reader + dashboard)

**Files:**
- Modify: `src/verify/local-reader.ts`
- Modify: `bin/dashboard.ts`

- [ ] **Step 1: Update `src/verify/local-reader.ts`**

Replace the duplicated projIdMap building with a `ProjectResolver` parameter. Use `resolver.entries()` to enumerate all known projects (including Supabase-only and org-root entries that aren't on disk). Thread the resolver through to `readLocalTokens()`.

```typescript
// Before (lines 185-233):
export function readAllLocal(
  supplementalProjIds?: Map<string, string>
): LocalData { ... }

// After:
import type { ProjectResolver } from "../project/resolver";

export function readAllLocal(resolver: ProjectResolver): LocalData {
  // Build projIdMap and projects list from resolver.entries()
  // This includes disk, Supabase local_names, org-root, and legacy — all sources
  const projIdMap = new Map<string, string>();
  const projects: LocalProject[] = [];
  const seenProjIds = new Set<string>();

  for (const [dirName, resolved] of resolver.entries()) {
    projIdMap.set(dirName, resolved.projId);

    // Only add one entry per projId to the projects list
    // (a project may appear under multiple dirNames)
    if (!seenProjIds.has(resolved.projId)) {
      projects.push({ dirName, slug: resolved.slug, projId: resolved.projId });
      seenProjIds.add(resolved.projId);
    }
  }

  const { events, logStartDate } = readLocalEvents(projIdMap);

  return {
    events,
    metrics: readLocalMetrics(),
    tokens: readLocalTokens(resolver),
    models: readLocalModels(),
    projects,
    hourDistribution: readHourDistribution(),
    daemon: readDaemonStatus(),
    logStartDate,
  };
}
```

Update `readLocalTokens()` to accept and pass the resolver:

```typescript
// Before:
function readLocalTokens(): LocalTokens {
  const tokenMap = scanProjectTokens();
  return { byProject: computeTokensByProject(tokenMap) };
}

// After:
function readLocalTokens(resolver?: ProjectResolver): LocalTokens {
  const tokenMap = scanProjectTokens(resolver);
  return { byProject: computeTokensByProject(tokenMap) };
}
```

Update the import block — remove all slug-resolver imports (no longer used directly):

```typescript
// Remove entirely:
import {
  buildSlugMap,
  clearSlugCache,
  resolveProjId,
  clearProjIdCache,
  PROJECT_ROOT,
} from "../project/slug-resolver";

// Add:
import type { ProjectResolver } from "../project/resolver";
```

Remove the `supplementalProjIds` parameter and all the supplemental merging logic (lines 198-220) — the `ProjectResolver.entries()` already includes historical names from Supabase `local_names`, org-root, and legacy mappings.

- [ ] **Step 2: Update `bin/dashboard.ts`**

Replace the two-pass supplementalProjIds approach with a single `ProjectResolver.refresh()` call.

```typescript
// Add import:
import { ProjectResolver } from "../src/project/resolver";

// In getSnapshot(), replace the supplemental projId logic:
async function getSnapshot(): Promise<{ local: LocalData; remote: RemoteData }> {
  if (cachedSnapshot && Date.now() - cachedSnapshot.ts < CACHE_TTL) {
    return cachedSnapshot;
  }

  // Single resolver handles disk + Supabase local_names + org-root + legacy
  const resolver = new ProjectResolver();
  await resolver.refresh(supabase);

  const local = readAllLocal(resolver);
  const remote = await readAllRemote(supabase, local.logStartDate ?? undefined);

  cachedSnapshot = { local, remote, ts: Date.now() };
  return cachedSnapshot;
}
```

Remove the `supplementalProjIds` logic (lines 47-58).

- [ ] **Step 3: Run tests**

```bash
bun test
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/verify/local-reader.ts bin/dashboard.ts
git commit -m "refactor: verify pipeline uses ProjectResolver — eliminates duplicated resolution"
```

---

### Task 4: Update `src/project/scanner.ts` to use ProjectResolver

**Files:**
- Modify: `src/project/scanner.ts`
- Modify: `bin/daemon.ts`

**Key design decision:** The scanner works with **encoded directory names** from `~/.claude/projects/` (e.g., `-Users-bigviking-Documents-github-projects-lo-nexus`). The `ProjectResolver` works with **plain directory names** (e.g., `nexus`). These are different key spaces.

The scanner's `resolveProjIdForDir()` has a two-step pipeline:
1. `resolveProjectName(encodedDirName)` — strips the encoded root prefix, fuzzy-matches against disk directories → plain name
2. `resolveProjId(join(PROJECT_ROOT, plainName))` — reads project.yml → projId
3. Legacy fallback: `loadLegacyMapping().get(encodedDirName)` — encoded name → projId

With `ProjectResolver`, step 2 becomes `resolver.resolve(plainName)` and step 3 becomes `resolver.resolve(encodedDirName)` (since the resolver loads legacy entries keyed by encoded names). Step 1 (`resolveProjectName`) stays in the scanner — it's a scanner-specific concern (decoding `~/.claude/projects/` paths).

- [ ] **Step 1: Update `resolveProjIdForDir` to use resolver**

Replace the function body while keeping `resolveProjectName` as the decoding step:

```typescript
import type { ProjectResolver } from "./resolver";

/**
 * Resolve an encoded ~/.claude/projects/ directory name to a projId.
 *
 * Two-step pipeline:
 * 1. Decode encoded path → plain directory name via resolveProjectName()
 * 2. Look up plain name in ProjectResolver (covers disk, Supabase, org-root)
 * 3. Fallback: look up encoded name directly in resolver (covers legacy mapping)
 * 4. Final fallback (no resolver): original resolveProjId + loadLegacyMapping
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

  // No resolver — original two-step resolution
  if (projectName) {
    const projId = resolveProjId(join(PROJECT_ROOT, projectName));
    if (projId) return projId;
  }
  return loadLegacyMapping().get(encodedDirName) ?? null;
}
```

- [ ] **Step 2: Update `scanProjectTokens` signature**

Add optional resolver parameter, pass through to `resolveProjIdForDir`:

```typescript
export function scanProjectTokens(resolver?: ProjectResolver): ProjectTokenMap {
  // ... existing code ...
  // Where resolveProjIdForDir(dirName) is called, change to:
  const projId = resolveProjIdForDir(dirName, resolver);
  // ... rest unchanged ...
}
```

- [ ] **Step 3: Update daemon.ts to pass resolver**

In `bin/daemon.ts`, wherever `scanProjectTokens()` is called, pass the resolver:

```typescript
// Before:
const projectTokenMap = scanProjectTokens();

// After:
const projectTokenMap = scanProjectTokens(resolver);
```

There are multiple call sites in daemon.ts — search for `scanProjectTokens()` and update each one.

- [ ] **Step 4: Run tests**

```bash
bun test
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/project/scanner.ts bin/daemon.ts
git commit -m "refactor: scanner uses ProjectResolver for dirName resolution"
```
