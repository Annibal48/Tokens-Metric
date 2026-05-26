import { readdirSync, statSync, createReadStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { claudeHome, codexSessionsDir } from './detect.js';
import { addUsage, EMPTY_USAGE, totalTokens, type Usage } from './types.js';
import { estimateCostUSD } from './format.js';
import {
  loadStore,
  replaceDayIn,
  saveStore,
  type DayAggregate,
} from './history-store.js';

export interface BucketStats {
  byModel: Record<string, Usage>;
  sessions: Set<string>;
}

export interface DayStats {
  dayStart: number;
  byModel: Record<string, Usage>;
}

export interface HistorySnapshot {
  today: BucketStats;
  d7: BucketStats;
  d30: BucketStats;
  last7Days: DayStats[];
  scannedFiles: number;
  generatedAt: number;
  oldestMtimeMs: number | null;
}

interface FileCache {
  mtimeMs: number;
  byDay: Map<number, Record<string, Usage>>;
  sessionId: string;
  earliestEventMs: number | null;
  latestEventMs: number | null;
  cwd: string | undefined;
}

export interface SessionSummary {
  sessionId: string;
  cwd: string | undefined;
  startedAt: number | null;
  endedAt: number | null;
  byModel: Record<string, Usage>;
  isActive: boolean;
}

const cache = new Map<string, FileCache>();
let storedDays: Map<number, DayAggregate> | null = null;

export async function buildHistory(now = Date.now()): Promise<HistorySnapshot> {
  if (storedDays === null) storedDays = loadStore();

  const claudeRoot = join(claudeHome(), 'projects');
  const codexRoot = codexSessionsDir();
  const allFiles: { path: string; mtimeMs: number }[] = [];

  if (existsSync(claudeRoot)) allFiles.push(...listAllJsonl(claudeRoot));
  if (existsSync(codexRoot)) allFiles.push(...listCodexJsonl(codexRoot));

  if (allFiles.length === 0) return aggregate(now);

  for (const f of allFiles) {
    const cached = cache.get(f.path);
    if (!cached || cached.mtimeMs < f.mtimeMs) {
      const parsed = f.path.includes('/.codex/sessions/')
        ? await parseCodexFile(f.path)
        : await parseFile(f.path);
      cache.set(f.path, {
        mtimeMs: f.mtimeMs,
        byDay: parsed.byDay,
        sessionId: parsed.sessionId,
        earliestEventMs: parsed.earliestEventMs,
        latestEventMs: parsed.latestEventMs,
        cwd: parsed.cwd,
      });
    }
  }

  const known = new Set(allFiles.map((f) => f.path));
  for (const key of Array.from(cache.keys())) {
    if (!known.has(key)) cache.delete(key);
  }

  return aggregate(now);
}

function aggregate(now: number): HistorySnapshot {
  const startToday = startOfDay(now);
  const start7 = startToday - 6 * 86_400_000;
  const start30 = startToday - 29 * 86_400_000;

  // Build the live per-day map from the in-memory cache. Each file knows its
  // sessionId, so we attach it to every day that file contributed to.
  const liveDays = new Map<number, DayAggregate>();
  for (const [, file] of cache) {
    for (const [dayStart, models] of file.byDay) {
      const entry = liveDays.get(dayStart) ?? { byModel: {}, sessions: new Set<string>() };
      entry.sessions.add(file.sessionId);
      for (const [model, usage] of Object.entries(models)) {
        entry.byModel[model] = addUsage(entry.byModel[model] ?? EMPTY_USAGE(), usage);
      }
      liveDays.set(dayStart, entry);
    }
  }

  // Merge: start from the stored archive, then overwrite any day where live
  // data exists (live transcripts are the authoritative source for days they
  // cover; the store keeps days whose transcripts no longer exist on disk).
  const merged = new Map<number, DayAggregate>();
  if (storedDays) {
    for (const [day, agg] of storedDays) {
      merged.set(day, {
        byModel: { ...agg.byModel },
        sessions: new Set(agg.sessions),
      });
    }
  }
  for (const [day, agg] of liveDays) {
    replaceDayIn(merged, day, agg.byModel, agg.sessions);
  }

  // Persist the merged view so historical days survive transcript deletion or
  // a future Claude Code log rotation.
  storedDays = merged;
  saveStore(merged);

  // Earliest data point — prefer the stored archive's earliest day key (since
  // events from deleted transcripts only live there now), but the live
  // earliest event timestamp is more precise when it sits within the archive.
  let oldest: number | null = null;
  for (const day of merged.keys()) {
    if (oldest === null || day < oldest) oldest = day;
  }
  for (const [, file] of cache) {
    const ts = file.earliestEventMs;
    if (ts !== null && (oldest === null || ts < oldest)) oldest = ts;
  }

  // last7Days: the 7 most recent days with data, oldest→newest
  const last7Days: DayStats[] = Array.from({ length: 7 }, (_, i) => ({
    dayStart: startToday - (6 - i) * 86_400_000,
    byModel: { ...(merged.get(startToday - (6 - i) * 86_400_000)?.byModel ?? {}) },
  }));

  const snap: HistorySnapshot = {
    today: { byModel: {}, sessions: new Set() },
    d7: { byModel: {}, sessions: new Set() },
    d30: { byModel: {}, sessions: new Set() },
    last7Days,
    scannedFiles: cache.size,
    generatedAt: now,
    oldestMtimeMs: oldest,
  };

  for (const [dayStart, agg] of merged) {
    const buckets: BucketStats[] = [];
    if (dayStart >= startToday) buckets.push(snap.today);
    if (dayStart >= start7) buckets.push(snap.d7);
    if (dayStart >= start30) buckets.push(snap.d30);
    if (buckets.length === 0) continue;
    for (const b of buckets) {
      for (const sid of agg.sessions) b.sessions.add(sid);
      for (const [model, usage] of Object.entries(agg.byModel)) {
        b.byModel[model] = addUsage(b.byModel[model] ?? EMPTY_USAGE(), usage);
      }
    }
  }

  return snap;
}

export function bucketTokens(b: BucketStats): number {
  let n = 0;
  for (const u of Object.values(b.byModel)) n += totalTokens(u);
  return n;
}

export function bucketCostUSD(b: BucketStats): number | null {
  let total = 0;
  let any = false;
  for (const [model, u] of Object.entries(b.byModel)) {
    const c = estimateCostUSD(model, u);
    if (c !== null) {
      total += c;
      any = true;
    }
  }
  return any ? total : null;
}

export function bucketTopModel(b: BucketStats): string | null {
  let topModel: string | null = null;
  let topTokens = -1;
  for (const [model, u] of Object.entries(b.byModel)) {
    const t = totalTokens(u);
    if (t > topTokens) {
      topTokens = t;
      topModel = model;
    }
  }
  return topModel;
}

function emptySnapshot(now: number, scannedFiles: number): HistorySnapshot {
  const startToday = startOfDay(now);
  return {
    today: { byModel: {}, sessions: new Set() },
    d7: { byModel: {}, sessions: new Set() },
    d30: { byModel: {}, sessions: new Set() },
    last7Days: Array.from({ length: 7 }, (_, i) => ({
      dayStart: startToday - (6 - i) * 86_400_000,
      byModel: {},
    })),
    scannedFiles,
    generatedAt: now,
    oldestMtimeMs: null,
  };
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function listAllJsonl(root: string): { path: string; mtimeMs: number }[] {
  const out: { path: string; mtimeMs: number }[] = [];
  for (const projectDir of safeReaddir(root)) {
    const full = join(root, projectDir);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    for (const f of safeReaddir(full)) {
      if (!f.endsWith('.jsonl')) continue;
      const p = join(full, f);
      try {
        const s = statSync(p);
        out.push({ path: p, mtimeMs: s.mtimeMs });
      } catch {
        // ignore
      }
    }
  }
  return out;
}

function safeReaddir(p: string): string[] {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}

interface ParsedFile {
  byDay: Map<number, Record<string, Usage>>;
  sessionId: string;
  earliestEventMs: number | null;
  latestEventMs: number | null;
  cwd: string | undefined;
}

async function parseFile(path: string): Promise<ParsedFile> {
  const byDay = new Map<number, Record<string, Usage>>();
  const sessionId = (path.split('/').pop() ?? path).replace(/\.jsonl$/, '');
  let earliestEventMs: number | null = null;
  let latestEventMs: number | null = null;
  let cwd: string | undefined;

  const stream = createReadStream(path, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let evt: any;
    try {
      evt = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof evt?.cwd === 'string' && !cwd) cwd = evt.cwd;
    const ts = typeof evt?.timestamp === 'string' ? Date.parse(evt.timestamp) : NaN;
    if (Number.isFinite(ts)) {
      if (earliestEventMs === null || ts < earliestEventMs) earliestEventMs = ts;
      if (latestEventMs === null || ts > latestEventMs) latestEventMs = ts;
    }
    const message = evt?.message;
    const usage = message?.usage;
    if (!usage) continue;
    if (!Number.isFinite(ts)) continue;
    const day = startOfDay(ts);
    const model = typeof message.model === 'string' ? message.model : 'unknown';
    const u: Partial<Usage> = {
      input_tokens: numberOr0(usage.input_tokens),
      output_tokens: numberOr0(usage.output_tokens),
      cache_creation_input_tokens: numberOr0(usage.cache_creation_input_tokens),
      cache_read_input_tokens: numberOr0(usage.cache_read_input_tokens),
    };
    const bucket = byDay.get(day) ?? {};
    bucket[model] = addUsage(bucket[model] ?? EMPTY_USAGE(), u);
    byDay.set(day, bucket);
  }

  return { byDay, sessionId, earliestEventMs, latestEventMs, cwd };
}

function numberOr0(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function listCodexJsonl(root: string): { path: string; mtimeMs: number }[] {
  const out: { path: string; mtimeMs: number }[] = [];
  for (const year of safeReaddir(root)) {
    for (const month of safeReaddir(join(root, year))) {
      for (const day of safeReaddir(join(root, year, month))) {
        const dayDir = join(root, year, month, day);
        for (const f of safeReaddir(dayDir)) {
          if (!f.endsWith('.jsonl')) continue;
          const p = join(dayDir, f);
          try {
            const s = statSync(p);
            out.push({ path: p, mtimeMs: s.mtimeMs });
          } catch {
            // ignore
          }
        }
      }
    }
  }
  return out;
}

async function parseCodexFile(path: string): Promise<ParsedFile> {
  const byDay = new Map<number, Record<string, Usage>>();
  const sessionId = (path.split('/').pop() ?? path).replace(/\.jsonl$/, '');
  let earliestEventMs: number | null = null;
  let latestEventMs: number | null = null;
  let cwd: string | undefined;

  const stream = createReadStream(path, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    let evt: any;
    try {
      evt = JSON.parse(line);
    } catch {
      continue;
    }

    if (evt?.type === 'session_meta' && typeof evt?.payload?.cwd === 'string') {
      if (!cwd) cwd = evt.payload.cwd;
    }

    const ts = typeof evt?.timestamp === 'string' ? Date.parse(evt.timestamp) : NaN;
    if (Number.isFinite(ts)) {
      if (earliestEventMs === null || ts < earliestEventMs) earliestEventMs = ts;
      if (latestEventMs === null || ts > latestEventMs) latestEventMs = ts;
    }

    if (evt?.type !== 'event_msg') continue;
    if (evt?.payload?.type !== 'token_count') continue;
    const info = evt?.payload?.info;
    if (!info) continue;
    const last = info.last_token_usage;
    if (!last) continue;
    if (!Number.isFinite(ts)) continue;

    const day = startOfDay(ts);
    const u: Partial<Usage> = {
      input_tokens: numberOr0(last.input_tokens),
      output_tokens: numberOr0(last.output_tokens) + numberOr0(last.reasoning_output_tokens),
      cache_read_input_tokens: numberOr0(last.cached_input_tokens),
      cache_creation_input_tokens: 0,
    };
    const bucket = byDay.get(day) ?? {};
    bucket['codex'] = addUsage(bucket['codex'] ?? EMPTY_USAGE(), u);
    byDay.set(day, bucket);
  }

  return { byDay, sessionId, earliestEventMs, latestEventMs, cwd };
}

/**
 * Returns all sessions (transcripts) that had activity today, sorted by
 * start time descending (most recent first). Marks the active one.
 */
export function getTodaySessions(now: number, activePath: string | null): SessionSummary[] {
  const startToday = startOfDay(now);
  const out: SessionSummary[] = [];

  for (const [path, file] of cache) {
    const todayUsage = file.byDay.get(startToday);
    if (!todayUsage) continue;
    out.push({
      sessionId: file.sessionId,
      cwd: file.cwd,
      startedAt: file.earliestEventMs,
      endedAt: file.latestEventMs,
      byModel: todayUsage,
      isActive: path === activePath,
    });
  }

  return out.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}
