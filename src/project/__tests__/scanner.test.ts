import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  resolveProjectName,
  resolveProjIdForDir,
} from "../scanner";
import { clearSlugCache, clearProjIdCache, PROJECT_ROOT } from "../slug-resolver";
import { existsSync } from "fs";

let tmpDir: string;

beforeEach(() => {
  clearSlugCache();
  clearProjIdCache();
  tmpDir = mkdtempSync(join(tmpdir(), "scanner-test-"));
});

// ─── resolveProjIdForDir with resolver ────────────────────────────────────────

describe("resolveProjIdForDir with resolver", () => {
  // Minimal ProjectResolver-like object for testing the resolver code path
  function fakeResolver(map: Record<string, { projId: string; slug: string }>) {
    return {
      resolve: (name: string) => map[name] ?? null,
    } as any;
  }

  // This test needs PROJECT_ROOT to exist with telemetry-exporter on disk
  // because resolveProjectName() calls readProjectDirs() to decode the encoded path
  const canResolveOnDisk = existsSync(PROJECT_ROOT) &&
    existsSync(join(PROJECT_ROOT, "telemetry-exporter"));

  test.skipIf(!canResolveOnDisk)("resolves via plain name when resolver is provided", () => {
    const resolver = fakeResolver({
      "telemetry-exporter": { projId: "proj_abc", slug: "telemetry-exporter" },
    });
    // The encoded name for this repo under PROJECT_ROOT
    const encodedRoot = PROJECT_ROOT.replace(/\//g, "-");
    const encoded = `${encodedRoot}-telemetry-exporter`;
    expect(resolveProjIdForDir(encoded, resolver)).toBe("proj_abc");
  });

  test("falls back to encoded name lookup (legacy entries)", () => {
    const resolver = fakeResolver({
      "legacy-encoded-name": { projId: "proj_legacy", slug: "legacy" },
    });
    // Encoded name that doesn't match any disk project
    expect(resolveProjIdForDir("legacy-encoded-name", resolver)).toBe("proj_legacy");
  });

  test("returns null when resolver has no match", () => {
    const resolver = fakeResolver({});
    expect(resolveProjIdForDir("unknown-dir", resolver)).toBeNull();
  });
});

// ─── resolveProjectName ─────────────────────────────────────────────────────

describe("resolveProjectName", () => {
  // Derive PROJECT_ROOT dynamically from the repo checkout location
  // so tests work in any environment (local dev, CI, etc.)
  const repoRoot = import.meta.dirname!.replace(/\/src\/project\/__tests__$/, "");
  const projectRoot = repoRoot.replace(/\/[^/]+$/, ""); // parent of repo = LO project root
  const encodedRoot = projectRoot.replace(/\//g, "-");
  const repoName = repoRoot.split("/").pop()!;

  test("returns null for unrecognized encoded dir name", () => {
    expect(resolveProjectName("some-random-path")).toBeNull();
  });

  test("returns null for org root without trailing project", () => {
    expect(resolveProjectName(encodedRoot)).toBeNull();
  });

  // This test depends on the actual PROJECT_ROOT matching the checkout location
  // and the repo directory existing on disk — skip gracefully in CI or other envs.
  const canResolveOnDisk =
    projectRoot === PROJECT_ROOT && existsSync(join(PROJECT_ROOT, repoName));

  test.skipIf(!canResolveOnDisk)(
    "resolves encoded dir name to project name for real projects on disk",
    () => {
      const result = resolveProjectName(`${encodedRoot}-${repoName}`);
      expect(result).toBe(repoName);
    },
  );
});
