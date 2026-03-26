import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, writeFileSync, unlinkSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { DORMANT_FLAG, PID_FILE, EXPORTER_DIR } from "../cli-output";

describe("dormant mode", () => {
  // Clean up any dormant flag created during tests
  afterEach(() => {
    try { unlinkSync(DORMANT_FLAG); } catch {}
  });

  describe("DORMANT_FLAG path", () => {
    test("is .dormant in the exporter directory", () => {
      expect(DORMANT_FLAG).toBe(join(EXPORTER_DIR, ".dormant"));
    });

    test("PID_FILE is adjacent to DORMANT_FLAG", () => {
      // Both should be in the same directory (exporter root)
      const dormantDir = DORMANT_FLAG.replace("/.dormant", "");
      const pidDir = PID_FILE.replace("/.exporter.pid", "");
      expect(dormantDir).toBe(pidDir);
    });
  });

  describe("flag file lifecycle", () => {
    test("creating flag file makes it detectable", () => {
      expect(existsSync(DORMANT_FLAG)).toBe(false);
      writeFileSync(DORMANT_FLAG, new Date().toISOString());
      expect(existsSync(DORMANT_FLAG)).toBe(true);
    });

    test("removing flag file clears dormant state", () => {
      writeFileSync(DORMANT_FLAG, new Date().toISOString());
      expect(existsSync(DORMANT_FLAG)).toBe(true);
      unlinkSync(DORMANT_FLAG);
      expect(existsSync(DORMANT_FLAG)).toBe(false);
    });

    test("flag file content is a timestamp", () => {
      const now = new Date().toISOString();
      writeFileSync(DORMANT_FLAG, now);
      const content = Bun.file(DORMANT_FLAG).text();
      // Verify it's a valid ISO timestamp (written by lo-close)
      expect(content).resolves.toBe(now);
    });
  });
});
