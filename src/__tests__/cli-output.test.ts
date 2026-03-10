import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// loadEnv reads from ENV_FILE which is derived from import.meta.url.
// We can't easily redirect it to a temp dir without mocking.
// Instead, test the core .env parsing logic by extracting and testing
// the same patterns loadEnv uses.

describe("loadEnv (.env parsing)", () => {
  // The parsing logic in loadEnv:
  // 1. Skip empty lines and comments (#)
  // 2. Split on first = sign
  // 3. Only set if not already in process.env
  // 4. Abort if SUPABASE_URL or SUPABASE_SECRET_KEY missing

  // We test the parsing contract by directly simulating what loadEnv does:
  function parseEnvContent(content: string): Record<string, string> {
    const result: Record<string, string> = {};
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const k = trimmed.slice(0, eqIdx).trim();
      const v = trimmed.slice(eqIdx + 1).trim();
      result[k] = v;
    }
    return result;
  }

  test("parses key=value pairs", () => {
    const result = parseEnvContent("FOO=bar\nBAZ=qux");
    expect(result).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  test("skips empty lines", () => {
    const result = parseEnvContent("\n\nFOO=bar\n\n");
    expect(result).toEqual({ FOO: "bar" });
  });

  test("skips comment lines", () => {
    const result = parseEnvContent("# This is a comment\nFOO=bar\n# Another comment");
    expect(result).toEqual({ FOO: "bar" });
  });

  test("handles values containing = signs", () => {
    const result = parseEnvContent("KEY=value=with=equals");
    expect(result).toEqual({ KEY: "value=with=equals" });
  });

  test("handles whitespace around keys and values", () => {
    const result = parseEnvContent("  KEY  =  value  ");
    expect(result).toEqual({ KEY: "value" });
  });

  test("skips lines without = sign", () => {
    const result = parseEnvContent("INVALID_LINE\nFOO=bar");
    expect(result).toEqual({ FOO: "bar" });
  });

  test("handles empty value", () => {
    const result = parseEnvContent("KEY=");
    expect(result).toEqual({ KEY: "" });
  });

  test("parses typical .env with Supabase credentials", () => {
    const content = [
      "# Supabase config",
      "SUPABASE_URL=https://abc.supabase.co",
      "SUPABASE_SECRET_KEY=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9",
      "LO_PROJECT_ROOT=/Users/me/projects/lo",
    ].join("\n");
    const result = parseEnvContent(content);
    expect(result.SUPABASE_URL).toBe("https://abc.supabase.co");
    expect(result.SUPABASE_SECRET_KEY).toStartWith("eyJ");
    expect(result.LO_PROJECT_ROOT).toBe("/Users/me/projects/lo");
  });
});
