import { describe, test, expect, beforeEach } from "bun:test";
import { RegistrationRetryTracker } from "../registration-retry";
import type { LogEntry } from "../parsers";

function fakeEntry(project: string, i: number): LogEntry {
  return {
    timestamp: `3/12 10:0${i} AM`,
    parsedTimestamp: new Date(`2026-03-12T10:0${i}:00`),
    project,
    branch: "main",
    emoji: "🔧",
    eventType: "tool",
    eventText: `event-${i}`,
  };
}

describe("RegistrationRetryTracker", () => {
  let tracker: RegistrationRetryTracker;

  beforeEach(() => {
    tracker = new RegistrationRetryTracker();
  });

  test("hasFailed returns false for unknown projId", () => {
    expect(tracker.hasFailed("proj_abc")).toBe(false);
  });

  test("markFailed makes hasFailed return true", () => {
    tracker.markFailed("proj_abc", "my-project", "my-project");
    expect(tracker.hasFailed("proj_abc")).toBe(true);
  });

  test("size tracks number of failed projects", () => {
    expect(tracker.size).toBe(0);
    tracker.markFailed("proj_a", "a", "a");
    tracker.markFailed("proj_b", "b", "b");
    expect(tracker.size).toBe(2);
  });

  test("bufferEvent stores and totalBuffered counts", () => {
    tracker.markFailed("proj_abc", "my-project", "my-project");
    expect(tracker.bufferEvent("proj_abc", fakeEntry("proj_abc", 0))).toBe(true);
    expect(tracker.bufferEvent("proj_abc", fakeEntry("proj_abc", 1))).toBe(true);
    expect(tracker.totalBuffered).toBe(2);
  });

  test("bufferEvent returns false when buffer is full", () => {
    tracker.markFailed("proj_abc", "my-project", "my-project");
    for (let i = 0; i < 1000; i++) {
      tracker.bufferEvent("proj_abc", fakeEntry("proj_abc", 0));
    }
    expect(tracker.bufferEvent("proj_abc", fakeEntry("proj_abc", 0))).toBe(false);
    expect(tracker.totalBuffered).toBe(1000);
  });

  test("getMeta returns stored dirName and slug", () => {
    tracker.markFailed("proj_abc", "my-project", "my-proj-slug");
    expect(tracker.getMeta("proj_abc")).toEqual({
      dirName: "my-project",
      slug: "my-proj-slug",
    });
  });

  test("getMeta returns undefined for unknown projId", () => {
    expect(tracker.getMeta("proj_unknown")).toBeUndefined();
  });

  test("markFailed does not overwrite existing meta", () => {
    tracker.markFailed("proj_abc", "original-dir", "original-slug");
    tracker.markFailed("proj_abc", "new-dir", "new-slug");
    expect(tracker.getMeta("proj_abc")).toEqual({
      dirName: "original-dir",
      slug: "original-slug",
    });
  });

  test("markSuccess clears failed state and returns buffered events", () => {
    tracker.markFailed("proj_abc", "my-project", "my-project");
    tracker.bufferEvent("proj_abc", fakeEntry("proj_abc", 0));
    tracker.bufferEvent("proj_abc", fakeEntry("proj_abc", 1));

    const drained = tracker.markSuccess("proj_abc");
    expect(drained).toHaveLength(2);
    expect(tracker.hasFailed("proj_abc")).toBe(false);
    expect(tracker.totalBuffered).toBe(0);
    expect(tracker.getMeta("proj_abc")).toBeUndefined();
  });

  test("markSuccess returns empty array when no buffer", () => {
    tracker.markFailed("proj_abc", "my-project", "my-project");
    const drained = tracker.markSuccess("proj_abc");
    expect(drained).toHaveLength(0);
  });

  test("newly failed project is ready on first periodic cycle", () => {
    tracker.markFailed("proj_abc", "my-project", "my-project");
    expect(tracker.getReadyToRetry(1)).toEqual(["proj_abc"]);
  });

  test("after recordAttempt, project is not ready until backoff elapses", () => {
    tracker.markFailed("proj_abc", "my-project", "my-project");
    tracker.recordAttempt("proj_abc", 1);
    expect(tracker.getReadyToRetry(1)).toEqual([]);
    expect(tracker.getReadyToRetry(2)).toEqual(["proj_abc"]);
  });

  test("backoff doubles: 1, 2, 4, then caps at 6", () => {
    tracker.markFailed("proj_abc", "my-project", "my-project");

    tracker.recordAttempt("proj_abc", 0);
    expect(tracker.getReadyToRetry(1)).toEqual(["proj_abc"]);

    tracker.recordAttempt("proj_abc", 1);
    expect(tracker.getReadyToRetry(2)).toEqual([]);
    expect(tracker.getReadyToRetry(3)).toEqual(["proj_abc"]);

    tracker.recordAttempt("proj_abc", 3);
    expect(tracker.getReadyToRetry(6)).toEqual([]);
    expect(tracker.getReadyToRetry(7)).toEqual(["proj_abc"]);

    tracker.recordAttempt("proj_abc", 7);
    expect(tracker.getReadyToRetry(12)).toEqual([]);
    expect(tracker.getReadyToRetry(13)).toEqual(["proj_abc"]);
  });

  test("getAbandonedToReport returns project after 6 failures", () => {
    tracker.markFailed("proj_abc", "my-project", "my-proj-slug");
    for (let i = 0; i < 6; i++) tracker.recordAttempt("proj_abc", i * 10);

    const abandoned = tracker.getAbandonedToReport();
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0]).toEqual({
      projId: "proj_abc",
      attempts: 6,
      dirName: "my-project",
      slug: "my-proj-slug",
    });
  });

  test("getAbandonedToReport returns empty before max attempts", () => {
    tracker.markFailed("proj_abc", "my-project", "my-project");
    for (let i = 0; i < 5; i++) tracker.recordAttempt("proj_abc", i * 10);
    expect(tracker.getAbandonedToReport()).toHaveLength(0);
  });

  test("abandoned project is excluded from getReadyToRetry", () => {
    tracker.markFailed("proj_abc", "my-project", "my-project");
    for (let i = 0; i < 6; i++) tracker.recordAttempt("proj_abc", i * 10);
    expect(tracker.getReadyToRetry(9999)).toEqual([]);
  });
});
