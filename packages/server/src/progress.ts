import type { ServerResponse } from 'node:http';
import type { ScanProgress, ScanProgressEvent } from '@vvv/shared';

export class Progress {
  readonly history: ScanProgressEvent[] = [];
  private pending = new Map<number, { snapshot: ScanProgress; timer: NodeJS.Timeout }>();
  private subscribers = new Map<
    ServerResponse,
    { id: number; send: (data: string) => void; stop: () => void }
  >();
  private closed = false;

  publish(snapshot: ScanProgress) {
    if (this.closed) return;
    const pending = this.pending.get(snapshot.id);
    if (pending) {
      pending.snapshot = snapshot;
      return;
    }
    const entry = {
      snapshot,
      timer: setTimeout(() => {
        this.pending.delete(snapshot.id);
        const event: ScanProgressEvent = { event: 'progress', data: entry.snapshot };
        this.history.push(event);
        if (this.history.length > 500) this.history.shift();
        for (const subscriber of this.subscribers.values()) {
          if (subscriber.id === snapshot.id)
            subscriber.send(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
        }
      }, 250),
    };
    entry.timer.unref();
    this.pending.set(snapshot.id, entry);
  }

  connect(response: ServerResponse, snapshot: ScanProgress) {
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
    const heartbeat = setInterval(() => send(': ping\n\n'), 15_000);
    heartbeat.unref();
    this.subscribers.set(response, { id: snapshot.id, send, stop });
    response.once('close', stop);
    response.once('error', stop);
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    response.flushHeaders();
    // Fresh DB snapshot only; Last-Event-ID does not replay retained history.
    this.publish(snapshot);
  }

  close() {
    this.closed = true;
    for (const entry of this.pending.values()) clearTimeout(entry.timer);
    this.pending.clear();
    for (const [response, subscriber] of this.subscribers) {
      subscriber.stop();
      response.destroy();
    }
    this.history.length = 0;
  }
}
