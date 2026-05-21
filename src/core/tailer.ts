import { open, watch, type FileHandle } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { applyLine } from './parser.js';
import { EMPTY_USAGE, type SessionStats } from './types.js';
import { deriveSessionId } from './parser.js';

export interface TailHandle {
  stats: SessionStats;
  stop: () => Promise<void>;
  onUpdate: (cb: (stats: SessionStats) => void) => void;
}

/**
 * Open a JSONL transcript, read everything currently in it, then watch for
 * appended lines. Calls onUpdate whenever the stats change.
 */
export async function tailTranscript(path: string): Promise<TailHandle> {
  const stats: SessionStats = {
    sessionId: deriveSessionId(path),
    transcriptPath: path,
    totals: EMPTY_USAGE(),
    byModel: {},
    messageCount: 0,
  };

  const listeners: ((s: SessionStats) => void)[] = [];
  const notify = () => listeners.forEach((l) => l(stats));

  let fh: FileHandle = await open(path, 'r');
  let offset = 0;
  let buf = '';
  let stopped = false;

  async function drain() {
    const size = statSync(path).size;
    if (size < offset) {
      // File was truncated/rotated — reopen.
      await fh.close();
      fh = await open(path, 'r');
      offset = 0;
      buf = '';
    }
    if (size === offset) return;
    const length = size - offset;
    const chunk = Buffer.alloc(length);
    const { bytesRead } = await fh.read(chunk, 0, length, offset);
    offset += bytesRead;
    buf += chunk.subarray(0, bytesRead).toString('utf8');
    let nl: number;
    let changed = false;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) {
        applyLine(stats, line);
        changed = true;
      }
    }
    if (changed) notify();
  }

  await drain();
  notify();

  // Native watcher. fs.watch on macOS uses FSEvents and may coalesce; that's
  // fine for our use case — we re-stat on each tick.
  const ac = new AbortController();
  (async () => {
    try {
      const watcher = watch(path, { signal: ac.signal });
      for await (const _ of watcher) {
        if (stopped) break;
        await drain().catch(() => undefined);
      }
    } catch {
      // aborted or file gone
    }
  })();

  return {
    stats,
    onUpdate(cb) {
      listeners.push(cb);
    },
    async stop() {
      stopped = true;
      ac.abort();
      await fh.close().catch(() => undefined);
    },
  };
}
