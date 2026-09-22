import type { ServerResponse } from 'node:http';
import type { ScanLogEntry, ScanLogLevel, ScanLogStep } from '@vvv/shared';

// Entries live only in memory: newest 500 per scan, newest 20 scans. They are
// operational diagnostics, not an audit trail, and do not survive a restart.
const PER_SCAN_LIMIT = 500;
const RETAINED_SCANS = 20;
const HEARTBEAT_MS = 15_000;

const frame = (entry: ScanLogEntry) =>
  `id: ${entry.id}\nevent: log\ndata: ${JSON.stringify(entry)}\n\n`;

export class ScanLog {
  private rings = new Map<number, ScanLogEntry[]>();
  private nextId = 1;
  private subscribers = new Map<
    ServerResponse,
    { scanId: number; send: (data: string) => void; stop: () => void }
  >();
  private closed = false;

  /** Record an entry, retain it in the bounded per-scan ring, and push it to live subscribers. */
  add(
    scanId: number,
    level: ScanLogLevel,
    step: ScanLogStep,
    detail: string,
    durationMs?: number
  ): ScanLogEntry {
    const entry: ScanLogEntry = {
      id: this.nextId++,
      ts: new Date().toISOString(),
      scan_id: scanId,
      step,
      detail,
      level,
      ...(durationMs === undefined ? {} : { duration_ms: Math.max(0, Math.round(durationMs)) }),
    };
    let ring = this.rings.get(scanId);
    if (!ring) {
      ring = [];
      this.rings.set(scanId, ring);
      while (this.rings.size > RETAINED_SCANS) {
        const oldest = this.rings.keys().next().value;
        if (oldest === undefined || oldest === scanId) break;
        this.rings.delete(oldest);
      }
    }
    ring.push(entry);
    if (ring.length > PER_SCAN_LIMIT) ring.shift();
    if (!this.closed) {
      const data = frame(entry);
      for (const subscriber of this.subscribers.values())
        if (subscriber.scanId === scanId) subscriber.send(data);
    }
    return entry;
  }

  /** Newest-first page from the retained rings; scan/level filters apply before pagination. */
  history(options: { scanId?: number; level?: ScanLogLevel; before?: number; limit: number }) {
    const { scanId, level, before, limit } = options;
    const source =
      scanId === undefined ? [...this.rings.values()].flat() : (this.rings.get(scanId) ?? []);
    const matched = source
      .filter(
        (entry) =>
          (level === undefined || entry.level === level) &&
          (before === undefined || entry.id < before)
      )
      .sort((a, b) => b.id - a.id)
      .slice(0, limit + 1);
    const items = matched.slice(0, limit);
    return { items, next_cursor: matched.length > limit ? String(items.at(-1)?.id) : null };
  }

  /**
   * Live entry stream for one scan. Entry ids are stable, so a reconnecting
   * client sends Last-Event-ID and receives only retained newer entries.
   */
  connect(response: ServerResponse, scanId: number, lastEventId = 0) {
    if (this.closed) {
      response.destroy();
      return;
    }
    const stop = () => {
      clearInterval(heartbeat);
      this.subscribers.delete(response);
      response.off('close', stop);
      response.off('error', stop);
    };
    const send = (data: string) => {
      if (response.write(data)) return;
      // Disconnect slow readers instead of retaining an unbounded outbound queue.
      stop();
      response.destroy();
    };
    const heartbeat = setInterval(() => send(': ping\n\n'), HEARTBEAT_MS);
    heartbeat.unref();
    this.subscribers.set(response, { scanId, send, stop });
    response.once('close', stop);
    response.once('error', stop);
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    response.flushHeaders();
    for (const entry of this.rings.get(scanId) ?? [])
      if (entry.id > lastEventId) send(frame(entry));
  }

  close() {
    this.closed = true;
    for (const [response, subscriber] of this.subscribers) {
      subscriber.stop();
      response.destroy();
    }
    this.subscribers.clear();
    this.rings.clear();
  }
}
