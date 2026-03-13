import type { LogEntry } from "./parsers";

export interface BufferedMeta {
  dirName: string;
  slug: string;
}

export class RegistrationRetryTracker {
  static readonly MAX_BUFFER = 1000;
  static readonly MAX_ATTEMPTS = 6;

  private failed = new Set<string>();
  private buffers = new Map<string, LogEntry[]>();
  private meta = new Map<string, BufferedMeta>();
  private attempts = new Map<string, number>();
  private nextRetry = new Map<string, number>();

  markFailed(projId: string, dirName: string, slug: string): void {
    this.failed.add(projId);
    if (!this.meta.has(projId)) {
      this.meta.set(projId, { dirName, slug });
      this.attempts.set(projId, 0);
      this.nextRetry.set(projId, 0);
    }
  }

  markSuccess(projId: string): LogEntry[] {
    this.failed.delete(projId);
    const buffered = this.buffers.get(projId) ?? [];
    this.buffers.delete(projId);
    this.meta.delete(projId);
    this.attempts.delete(projId);
    this.nextRetry.delete(projId);
    return buffered;
  }

  hasFailed(projId: string): boolean {
    return this.failed.has(projId);
  }

  bufferEvent(projId: string, entry: LogEntry): boolean {
    const buf = this.buffers.get(projId) ?? [];
    if (buf.length >= RegistrationRetryTracker.MAX_BUFFER) return false;
    buf.push(entry);
    this.buffers.set(projId, buf);
    return true;
  }

  getMeta(projId: string): BufferedMeta | undefined {
    return this.meta.get(projId);
  }

  getReadyToRetry(currentCycle: number): string[] {
    const ready: string[] = [];
    for (const projId of this.failed) {
      const attempt = this.attempts.get(projId) ?? 0;
      if (attempt >= RegistrationRetryTracker.MAX_ATTEMPTS) continue;
      const next = this.nextRetry.get(projId) ?? 0;
      if (currentCycle >= next) ready.push(projId);
    }
    return ready;
  }

  recordAttempt(projId: string, currentCycle: number): void {
    const attempt = (this.attempts.get(projId) ?? 0) + 1;
    this.attempts.set(projId, attempt);
    const delayCycles = Math.min(2 ** (attempt - 1), 6);
    this.nextRetry.set(projId, currentCycle + delayCycles);
  }

  getAbandonedToReport(): Array<{
    projId: string;
    attempts: number;
    dirName: string;
    slug: string;
  }> {
    const abandoned: Array<{
      projId: string;
      attempts: number;
      dirName: string;
      slug: string;
    }> = [];
    for (const projId of this.failed) {
      const attempt = this.attempts.get(projId) ?? 0;
      if (attempt >= RegistrationRetryTracker.MAX_ATTEMPTS) {
        const m = this.meta.get(projId);
        if (m) abandoned.push({ projId, attempts: attempt, ...m });
      }
    }
    return abandoned;
  }

  get size(): number {
    return this.failed.size;
  }

  get totalBuffered(): number {
    let total = 0;
    for (const buf of this.buffers.values()) total += buf.length;
    return total;
  }
}
