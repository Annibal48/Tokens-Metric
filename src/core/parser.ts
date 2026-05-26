import { readdirSync, statSync, createReadStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { claudeHome, codexSessionsDir } from './detect.js';
import {
  addUsage,
  EMPTY_USAGE,
  type SessionStats,
  type Usage,
} from './types.js';

const PROJECTS_DIR = () => join(claudeHome(), 'projects');

/**
 * Walk ~/.claude/projects/<encoded-cwd>/*.jsonl and return all transcript
 * files sorted by mtime descending (most recent first).
 */
export function listTranscripts(): { path: string; mtimeMs: number; cwd: string }[] {
  const root = PROJECTS_DIR();
  if (!existsSync(root)) return [];
  const out: { path: string; mtimeMs: number; cwd: string }[] = [];
  for (const projectDir of safeReaddir(root)) {
    const full = join(root, projectDir);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    for (const f of safeReaddir(full)) {
      if (!f.endsWith('.jsonl')) continue;
      const p = join(full, f);
      try {
        const s = statSync(p);
        out.push({ path: p, mtimeMs: s.mtimeMs, cwd: decodeCwd(projectDir) });
      } catch {
        // ignore
      }
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function safeReaddir(p: string): string[] {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}

/**
 * Claude Code encodes the cwd by replacing path separators with `-`.
 * We can't perfectly recover the original, but we can give a best-effort
 * human-readable hint.
 */
function decodeCwd(encoded: string): string {
  return encoded.replace(/^-/, '/').replace(/-/g, '/');
}

/**
 * Pick the most recently active transcript within `withinMs` (default 5 min).
 */
export function findActiveTranscript(withinMs = 5 * 60_000): { path: string; cwd: string } | null {
  const list = listTranscripts();
  if (list.length === 0) return null;
  const top = list[0];
  if (Date.now() - top.mtimeMs > withinMs) {
    // Still return it as "last known", but caller can decide.
    return { path: top.path, cwd: top.cwd };
  }
  return { path: top.path, cwd: top.cwd };
}

/**
 * Read a JSONL transcript fully and aggregate usage stats.
 */
export async function aggregateTranscript(path: string): Promise<SessionStats> {
  const stats: SessionStats = {
    sessionId: deriveSessionId(path),
    transcriptPath: path,
    totals: EMPTY_USAGE(),
    byModel: {},
    messageCount: 0,
    lastMsgUsage: null,
  };

  const stream = createReadStream(path, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    applyLine(stats, line);
  }
  return stats;
}

export function deriveSessionId(path: string): string {
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.jsonl$/, '');
}

/**
 * Apply a single JSONL line to a running stats object. Tolerant to
 * unexpected shapes — Claude Code's transcript format evolves.
 */
export function applyLine(stats: SessionStats, line: string): void {
  let evt: any;
  try {
    evt = JSON.parse(line);
  } catch {
    return;
  }

  if (typeof evt?.cwd === 'string' && !stats.cwd) stats.cwd = evt.cwd;
  const ts = parseTimestamp(evt?.timestamp);
  if (ts) {
    stats.startedAt = stats.startedAt ? Math.min(stats.startedAt, ts) : ts;
    stats.lastEventAt = stats.lastEventAt ? Math.max(stats.lastEventAt, ts) : ts;
  }

  const message = evt?.message;
  if (!message || typeof message !== 'object') return;

  const usage = message.usage;
  if (!usage) return;

  const u: Partial<Usage> = {
    input_tokens: numberOr0(usage.input_tokens),
    output_tokens: numberOr0(usage.output_tokens),
    cache_creation_input_tokens: numberOr0(usage.cache_creation_input_tokens),
    cache_read_input_tokens: numberOr0(usage.cache_read_input_tokens),
  };

  const model = typeof message.model === 'string' ? message.model : 'unknown';
  stats.lastModel = model;
  stats.totals = addUsage(stats.totals, u);
  stats.byModel[model] = addUsage(stats.byModel[model] ?? EMPTY_USAGE(), u);
  stats.messageCount += 1;
  // Overwrite — we only care about the most recent turn's context footprint.
  stats.lastMsgUsage = { ...EMPTY_USAGE(), ...u };
}

function numberOr0(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function parseTimestamp(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined;
  const n = Date.parse(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Aggregate a transcript using the appropriate parser (auto-detected by path).
 */
export async function aggregateAnyTranscript(path: string): Promise<SessionStats> {
  if (path.includes('/.codex/sessions/')) {
    const stats: SessionStats = {
      sessionId: deriveSessionId(path),
      transcriptPath: path,
      totals: EMPTY_USAGE(),
      byModel: {},
      messageCount: 0,
      lastMsgUsage: null,
    };
    const stream = (await import('node:fs')).createReadStream(path, { encoding: 'utf8' });
    const rl = (await import('node:readline')).createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (line.trim()) applyCodexLine(stats, line);
    }
    return stats;
  }
  return aggregateTranscript(path);
}

/**
 * Returns the most recently active transcript across Claude Code and Codex CLI,
 * or null if neither has a session within the window.
 */
export function findMostRecentActiveTranscript(withinMs = 5 * 60_000): { path: string; cwd: string } | null {
  const claude = findActiveTranscript(withinMs);
  const codex = findActiveCodexTranscript(withinMs);
  if (!claude && !codex) return null;
  if (!claude) return codex;
  if (!codex) return claude;
  // Both exist — pick the one with the most recent file
  const claudeMtime = listTranscripts()[0]?.mtimeMs ?? 0;
  const codexMtime = listCodexTranscripts()[0]?.mtimeMs ?? 0;
  return codexMtime > claudeMtime ? codex : claude;
}

// ─── Codex CLI support ────────────────────────────────────────────────────────

const CODEX_SESSIONS_DIR = () => codexSessionsDir();

/**
 * Walk ~/.codex/sessions/YYYY/MM/DD/*.jsonl and return transcript files
 * sorted by mtime descending.
 */
export function listCodexTranscripts(): { path: string; mtimeMs: number; cwd: string }[] {
  const root = CODEX_SESSIONS_DIR();
  if (!existsSync(root)) return [];
  const out: { path: string; mtimeMs: number; cwd: string }[] = [];
  for (const year of safeReaddir(root)) {
    for (const month of safeReaddir(join(root, year))) {
      for (const day of safeReaddir(join(root, year, month))) {
        const dayDir = join(root, year, month, day);
        for (const f of safeReaddir(dayDir)) {
          if (!f.endsWith('.jsonl')) continue;
          const p = join(dayDir, f);
          try {
            const s = statSync(p);
            out.push({ path: p, mtimeMs: s.mtimeMs, cwd: '' });
          } catch {
            // ignore
          }
        }
      }
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Pick the most recently active Codex transcript within `withinMs`.
 */
export function findActiveCodexTranscript(withinMs = 5 * 60_000): { path: string; cwd: string } | null {
  const list = listCodexTranscripts();
  if (list.length === 0) return null;
  const top = list[0];
  if (Date.now() - top.mtimeMs > withinMs) {
    return { path: top.path, cwd: top.cwd };
  }
  return { path: top.path, cwd: top.cwd };
}

/**
 * Apply a single Codex JSONL line to a running stats object.
 * Codex emits `event_msg / token_count` events with `last_token_usage`
 * (per-turn delta). Summing deltas across a session equals the cumulative
 * total, so we use the same additive approach as the Claude parser.
 */
export function applyCodexLine(stats: SessionStats, line: string): void {
  let evt: any;
  try {
    evt = JSON.parse(line);
  } catch {
    return;
  }

  const ts = parseTimestamp(evt?.timestamp);
  if (ts) {
    stats.startedAt = stats.startedAt ? Math.min(stats.startedAt, ts) : ts;
    stats.lastEventAt = stats.lastEventAt ? Math.max(stats.lastEventAt, ts) : ts;
  }

  if (evt?.type === 'session_meta' && typeof evt?.payload?.cwd === 'string') {
    if (!stats.cwd) stats.cwd = evt.payload.cwd;
  }

  if (evt?.type !== 'event_msg') return;
  if (evt?.payload?.type !== 'token_count') return;

  const info = evt?.payload?.info;
  if (!info) return;

  const last = info.last_token_usage;
  if (!last) return;

  const u: Partial<Usage> = {
    input_tokens: numberOr0(last.input_tokens),
    output_tokens: numberOr0(last.output_tokens) + numberOr0(last.reasoning_output_tokens),
    cache_read_input_tokens: numberOr0(last.cached_input_tokens),
    cache_creation_input_tokens: 0,
  };

  stats.totals = addUsage(stats.totals, u);
  stats.byModel['codex'] = addUsage(stats.byModel['codex'] ?? EMPTY_USAGE(), u);
  stats.lastModel = 'codex';
  stats.messageCount += 1;
}
