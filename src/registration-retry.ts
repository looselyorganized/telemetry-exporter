import type { LogEntry } from "./parsers";

export interface BufferedMeta {
  dirName: string;
  slug: string;
}

interface TrackedProject {
  meta: BufferedMeta;
  buffer: LogEntry[];
  attempts: number;
  nextRetry: number;
}

export class RegistrationRetryTracker {
  static readonly MAX_BUFFER = 1000;
  static readonly MAX_ATTEMPTS = 6;

  private projects = new Map<string, TrackedProject>();

  markFailed(projId: string, dirName: string, slug: string): void {
    if (!this.projects.has(projId)) {
      this.projects.set(projId, {
        meta: { dirName, slug },
        buffer: [],
        attempts: 0,
        nextRetry: 0,
      });
    }
  }

  markSuccess(projId: string): LogEntry[] {
    const tracked = this.projects.get(projId);
    this.projects.delete(projId);
    return tracked?.buffer ?? [];
  }

  hasFailed(projId: string): boolean {
    return this.projects.has(projId);
  }

  bufferEvent(projId: string, entry: LogEntry): boolean {
    const tracked = this.projects.get(projId);
    if (!tracked || tracked.buffer.length >= RegistrationRetryTracker.MAX_BUFFER) return false;
    tracked.buffer.push(entry);
    return true;
  }

  getMeta(projId: string): BufferedMeta | undefined {
    return this.projects.get(projId)?.meta;
  }

  getReadyToRetry(currentCycle: number): string[] {
    const ready: string[] = [];
    for (const [projId, tracked] of this.projects) {
      if (tracked.attempts >= RegistrationRetryTracker.MAX_ATTEMPTS) continue;
      if (currentCycle >= tracked.nextRetry) ready.push(projId);
    }
    return ready;
  }

  recordAttempt(projId: string, currentCycle: number): void {
    const tracked = this.projects.get(projId);
    if (!tracked) return;
    tracked.attempts++;
    const delayCycles = Math.min(2 ** (tracked.attempts - 1), 6);
    tracked.nextRetry = currentCycle + delayCycles;
  }

  getAbandonedToReport(): Array<{
    projId: string;
    attempts: number;
    dirName: string;
    slug: string;
  }> {
    const abandoned: Array<{ projId: string; attempts: number; dirName: string; slug: string }> = [];
    for (const [projId, tracked] of this.projects) {
      if (tracked.attempts >= RegistrationRetryTracker.MAX_ATTEMPTS) {
        abandoned.push({ projId, attempts: tracked.attempts, ...tracked.meta });
      }
    }
    return abandoned;
  }

  get size(): number {
    return this.projects.size;
  }

  get totalBuffered(): number {
    let total = 0;
    for (const tracked of this.projects.values()) total += tracked.buffer.length;
    return total;
  }
}
