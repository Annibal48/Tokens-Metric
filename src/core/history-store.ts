import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { addUsage, EMPTY_USAGE, type Usage } from './types.js';

export interface DayAggregate {
  byModel: Record<string, Usage>;
  sessions: Set<string>;
}

export interface StoreShape {
  version: number;
  days: Record<string, { byModel: Record<string, Usage>; sessions: string[] }>;
}

const STORE_VERSION = 1;
const STORE_PATH = () => join(homedir(), '.tokens-metric', 'history.json');

/**
 * Read the on-disk store. Returns an empty map if the file does not exist
 * or is unreadable/malformed — the caller can keep working from live data.
 */
export function loadStore(): Map<number, DayAggregate> {
  const path = STORE_PATH();
  if (!existsSync(path)) return new Map();
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as StoreShape;
    if (parsed?.version !== STORE_VERSION || !parsed.days) return new Map();
    const out = new Map<number, DayAggregate>();
    for (const [date, day] of Object.entries(parsed.days)) {
      const dayMs = parseDateKey(date);
      if (dayMs === null) continue;
      const byModel: Record<string, Usage> = {};
      for (const [model, usage] of Object.entries(day.byModel ?? {})) {
        byModel[model] = sanitizeUsage(usage);
      }
      out.set(dayMs, {
        byModel,
        sessions: new Set(Array.isArray(day.sessions) ? day.sessions : []),
      });
    }
    return out;
  } catch {
    return new Map();
  }
}

/**
 * Persist a snapshot of per-day aggregates atomically. Failures are
 * swallowed — losing one write is recoverable on next refresh.
 */
export function saveStore(days: Map<number, DayAggregate>): void {
  const path = STORE_PATH();
  try {
    mkdirSync(dirname(path), { recursive: true });
    const out: StoreShape = { version: STORE_VERSION, days: {} };
    for (const [dayMs, agg] of days) {
      out.days[formatDateKey(dayMs)] = {
        byModel: agg.byModel,
        sessions: Array.from(agg.sessions),
      };
    }
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(out), 'utf8');
    renameSync(tmp, path);
  } catch {
    // ignore — next refresh will retry
  }
}

export function mergeDayInto(
  target: Map<number, DayAggregate>,
  dayMs: number,
  byModel: Record<string, Usage>,
  sessions: Iterable<string>,
): void {
  const existing = target.get(dayMs) ?? { byModel: {}, sessions: new Set<string>() };
  for (const [model, usage] of Object.entries(byModel)) {
    existing.byModel[model] = addUsage(existing.byModel[model] ?? EMPTY_USAGE(), usage);
  }
  for (const sid of sessions) existing.sessions.add(sid);
  target.set(dayMs, existing);
}

export function replaceDayIn(
  target: Map<number, DayAggregate>,
  dayMs: number,
  byModel: Record<string, Usage>,
  sessions: Iterable<string>,
): void {
  const next: DayAggregate = { byModel: {}, sessions: new Set(sessions) };
  for (const [model, usage] of Object.entries(byModel)) {
    next.byModel[model] = { ...usage };
  }
  target.set(dayMs, next);
}

function formatDateKey(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseDateKey(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
  return Number.isFinite(d.getTime()) ? d.getTime() : null;
}

function sanitizeUsage(u: unknown): Usage {
  const x = (u ?? {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return {
    input_tokens: n(x.input_tokens),
    output_tokens: n(x.output_tokens),
    cache_creation_input_tokens: n(x.cache_creation_input_tokens),
    cache_read_input_tokens: n(x.cache_read_input_tokens),
  };
}
