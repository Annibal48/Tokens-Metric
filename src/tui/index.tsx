#!/usr/bin/env node
import React, { useEffect, useRef, useState } from 'react';
import { render, Box, Text, useApp, useInput } from 'ink';
import { findActiveTranscript, listTranscripts } from '../core/parser.js';
import { tailTranscript, type TailHandle } from '../core/tailer.js';
import { detectAuth } from '../core/detect.js';
import { categoryCostUSD, estimateCostUSD, fmtNumber, fmtUSD } from '../core/format.js';
import {
  buildHistory,
  bucketCostUSD,
  bucketTokens,
  bucketTopModel,
  getTodaySessions,
  type BucketStats,
  type HistorySnapshot,
  type SessionSummary,
} from '../core/history.js';
import { totalTokens, type AuthInfo, type SessionStats } from '../core/types.js';
import { anonymizePath } from '../core/privacy.js';
import { createRequire } from 'node:module';
import { HELP_TEXT, parseArgs } from '../core/args.js';
import { checkForUpdate } from '../core/updater.js';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json') as { version: string };
import { bar, sparklineCells } from './bars.js';

const OPTS = parseArgs(process.argv);
if (OPTS.help) {
  process.stdout.write(HELP_TEXT);
  process.exit(0);
}

const RESCAN_MS = 3_000;
const HISTORY_REFRESH_MS = 60_000;
const SPARK_WIDTH = 32;
const BAR_WIDTH = 20;

function App() {
  const { exit } = useApp();
  const [auth] = useState<AuthInfo>(() => detectAuth());
  const [stats, setStats] = useState<SessionStats | null>(null);
  const [transcriptPath, setTranscriptPath] = useState<string | null>(null);
  const [series, setSeries] = useState<number[]>(() => Array(SPARK_WIDTH).fill(0));
  const [now, setNow] = useState<number>(Date.now());
  const [lastTailAt, setLastTailAt] = useState<number | null>(null);
  const [history, setHistory] = useState<HistorySnapshot | null>(null);
  const [updateAvailable, setUpdateAvailable] = useState<string | null>(null);
  // focusedTab: where the cursor sits (arrow navigation)
  // openTab: which panel is expanded (null = all collapsed)
  const [focusedTab, setFocusedTab] = useState<1 | 2 | 3 | 4>(1);
  const [openTab, setOpenTab] = useState<1 | 2 | 3 | 4 | null>(null);
  const startedAtRef = useRef<number>(Date.now());
  const lastTotalRef = useRef(0);

  // useInput requires raw mode (interactive TTY). Skip it when stdin is piped
  // or otherwise non-interactive, so `node dist/tui/index.js | cat` still
  // renders instead of crashing.
  const interactive = Boolean(process.stdin.isTTY);
  if (interactive) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useInput((input, key) => {
      if (input === 'q' || (key.ctrl && input === 'c')) exit();
      if (key.escape) { setOpenTab(null); return; }
      // Arrow keys move the cursor
      if (key.leftArrow)  { setFocusedTab((t) => (t > 1 ? (t - 1) as 1|2|3|4 : t)); return; }
      if (key.rightArrow) { setFocusedTab((t) => (t < 4 ? (t + 1) as 1|2|3|4 : t)); return; }
      // Enter opens/collapses the focused tab
      if (key.return) {
        setOpenTab((o) => (o === focusedTab ? null : focusedTab));
        return;
      }
      // Number shortcuts: jump directly and open
      if (input === '1') { setFocusedTab(1); setOpenTab(1); }
      if (input === '2') { setFocusedTab(2); setOpenTab(2); }
      if (input === '3') { setFocusedTab(3); setOpenTab(3); }
      if (input === '4') { setFocusedTab(4); setOpenTab(4); }
    });
  }

  // Check for newer version on npm — non-blocking, result cached 24h.
  useEffect(() => {
    checkForUpdate(pkg.version)
      .then((v) => { if (v) setUpdateAvailable(v); })
      .catch(() => undefined);
  }, []);

  // Historical aggregate over all transcripts. Refreshed on an interval —
  // the live session is already shown in SessionPanel, so minute-grain
  // accuracy on today's bucket is enough and keeps full parses out of the
  // hot path.
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      buildHistory()
        .then((h) => {
          if (!cancelled) setHistory(h);
        })
        .catch(() => undefined);
    };
    refresh();
    const t = setInterval(refresh, HISTORY_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  // Wall-clock tick + sparkline slot rotation (1 Hz).
  useEffect(() => {
    const t = setInterval(() => {
      setNow(Date.now());
      setSeries((s) => [...s.slice(1), 0]);
    }, 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let handle: TailHandle | null = null;
    let cancelled = false;

    async function attach(path: string) {
      handle?.stop().catch(() => undefined);
      setTranscriptPath(path);
      handle = await tailTranscript(path);
      if (cancelled) {
        handle.stop();
        return;
      }
      // Seed initial state — tailTranscript already drained the file once
      // before returning, but its first notify() fires before any listener
      // is attached, so we'd otherwise wait for the next appended line.
      lastTotalRef.current = totalTokens(handle.stats.totals);
      setLastTailAt(Date.now());
      setStats({ ...handle.stats });
      handle.onUpdate((s) => {
        setLastTailAt(Date.now());
        const tot = totalTokens(s.totals);
        const delta = Math.max(0, tot - lastTotalRef.current);
        if (delta > 0) {
          setSeries((arr) => {
            const next = arr.slice();
            next[next.length - 1] = (next[next.length - 1] ?? 0) + delta;
            return next;
          });
        }
        lastTotalRef.current = tot;
        setStats({ ...s });
      });
    }

    async function rescan() {
      const active = findActiveTranscript();
      if (active && active.path !== transcriptPath) await attach(active.path);
    }

    rescan();
    const interval = setInterval(rescan, RESCAN_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
      handle?.stop().catch(() => undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const allTranscripts = listTranscripts();
  const transcripts = allTranscripts.slice(0, 5);
  const today = countToday(allTranscripts, now);
  const ratePerSec = series.reduce((a, b) => a + b, 0) / SPARK_WIDTH;
  const todaySessions = getTodaySessions(now, transcriptPath);

  return (
    <Box flexDirection="column" padding={1}>
      <Header
        auth={auth}
        sessionsToday={today.sessions}
        projectsToday={today.projects}
        lastTailAt={lastTailAt}
        startedAt={startedAtRef.current}
        now={now}
        updateAvailable={updateAvailable}
      />

      <Box marginTop={1}>
        <SessionStatusBar stats={stats} ratePerSec={ratePerSec} now={now} series={series} />
      </Box>

      <Box marginTop={1}>
        <TabBar focusedTab={focusedTab} openTab={openTab} />
      </Box>

      {openTab !== null && (
        <Box marginTop={1}>
          {openTab === 1 && (
            <BreakdownPanel stats={stats} series={series} ratePerSec={ratePerSec} />
          )}
          {openTab === 2 && <HistoryPanel history={history} />}
          {openTab === 3 && <TodaySessionsPanel sessions={todaySessions} now={now} />}
          {openTab === 4 && (
            <TranscriptsPanel
              transcripts={transcripts}
              activePath={transcriptPath}
              now={now}
            />
          )}
        </Box>
      )}

      <Box marginTop={1}>
        <Text dimColor>
          <Text color="magenta">q</Text> quit ·{' '}
          <Text color="magenta">←→</Text> move ·{' '}
          <Text color="magenta">enter</Text> open/close ·{' '}
          <Text color="magenta">1–4</Text> jump · pricing is{' '}
          <Text italic>API-equivalent</Text>, not your real bill on a subscription
        </Text>
      </Box>
    </Box>
  );
}

// ── Header ───────────────────────────────────────────────────────────────────
function Header({
  auth,
  sessionsToday,
  projectsToday,
  lastTailAt,
  startedAt,
  now,
  updateAvailable,
}: {
  auth: AuthInfo;
  sessionsToday: number;
  projectsToday: number;
  lastTailAt: number | null;
  startedAt: number;
  now: number;
  updateAvailable: string | null;
}) {
  const ok = auth.installed && auth.loggedIn;
  const dot = ok ? 'green' : auth.installed ? 'yellow' : 'red';
  const tailAgo = lastTailAt ? `updated ${timeAgo(now - lastTailAt)} ago` : 'waiting…';
  const tailIsLive = !!lastTailAt && now - lastTailAt < 10_000;
  const tailColor = !lastTailAt ? 'gray' : tailIsLive ? 'green' : 'yellow';
  const tailStatusText = !lastTailAt ? '' : tailIsLive ? '● live' : '⚠ stale';

  return (
    <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
      <Box>
        <Text bold color="cyan">▌ tokens-metric </Text>
        <Text dimColor>v{pkg.version} — real-time Claude Code usage</Text>
      </Box>
      <Box marginTop={0}>
        <Text>
          <Text color={dot}>●</Text>{' '}
          {auth.installed ? 'Claude Code detected' : 'Claude Code NOT detected'}
          <Text dimColor>{'   ·   '}</Text>
          <Text>{sessionsToday}</Text>
          <Text dimColor>{` ${plural(sessionsToday, 'session', 'sessions')} · `}</Text>
          <Text>{projectsToday}</Text>
          <Text dimColor>{` ${plural(projectsToday, 'project', 'projects')} today`}</Text>
        </Text>
      </Box>
      <Box>
        <Text dimColor>watching ~/.claude/projects · </Text>
        {tailStatusText ? <Text color={tailColor}>{tailStatusText} </Text> : null}
        <Text dimColor>{tailAgo}</Text>
        <Text dimColor>{'   ·   uptime '}</Text>
        <Text>{timeAgo(now - startedAt)}</Text>
      </Box>
      {updateAvailable && (
        <Box>
          <Text color="yellow">⚡ Update available: </Text>
          <Text dimColor>v{pkg.version}</Text>
          <Text color="yellow"> → </Text>
          <Text color="yellow" bold>v{updateAvailable}</Text>
          <Text dimColor>   npm install -g tokens-metric</Text>
        </Box>
      )}
    </Box>
  );
}

function countToday(
  transcripts: { mtimeMs: number; cwd: string }[],
  now: number,
): { sessions: number; projects: number } {
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const cutoff = startOfDay.getTime();
  const projects = new Set<string>();
  let sessions = 0;
  for (const t of transcripts) {
    if (t.mtimeMs < cutoff) continue;
    sessions++;
    projects.add(t.cwd);
  }
  return { sessions, projects: projects.size };
}

// ── Session status bar (always-visible compact one-liner) ────────────────────
function SessionStatusBar({
  stats,
  ratePerSec,
  now,
  series,
}: {
  stats: SessionStats | null;
  ratePerSec: number;
  now: number;
  series: number[];
}) {
  if (!stats) {
    return (
      <Box borderStyle="round" borderColor="green" paddingX={1}>
        <Text dimColor>○  No active session — waiting for Claude Code…</Text>
      </Box>
    );
  }

  const isIdle = !stats.lastEventAt || now - stats.lastEventAt > 60_000;
  const cost = estimateCostUSD(stats.lastModel ?? '', stats.totals);
  const tokens = totalTokens(stats.totals);
  const hasActivity = series.some((n) => n > 0);
  const MINI_SPARK = 16;

  return (
    <Box borderStyle="round" borderColor="green" paddingX={1} flexDirection="row" flexWrap="wrap">
      <Text color="green" bold>●  </Text>
      <Text bold color="cyan">{shortModel(stats.lastModel ?? '—')}</Text>
      <Text dimColor>  ·  </Text>
      <Text bold>{fmtNumber(tokens)}</Text>
      <Text dimColor> tok</Text>
      {cost !== null && (
        <>
          <Text dimColor>  ·  ~</Text>
          <Text>{fmtUSD(cost)}</Text>
        </>
      )}
      <Text dimColor>  ·  </Text>
      <Text>{stats.messageCount}</Text>
      <Text dimColor> msgs</Text>
      {stats.startedAt !== undefined && stats.startedAt !== null && (
        <>
          <Text dimColor>  ·  since </Text>
          <Text>{fmtTime(stats.startedAt)}</Text>
        </>
      )}
      {hasActivity && (
        <>
          <Text>{'   '}</Text>
          {sparklineCells(series, MINI_SPARK).map((cell, i) => {
            const isCurrentSlot = i === MINI_SPARK - 1 && cell.intensity > 0;
            return (
              <Text
                key={i}
                color={isCurrentSlot ? 'white' : intensityColor(cell.intensity)}
                bold={isCurrentSlot}
              >
                {cell.char}
              </Text>
            );
          })}
        </>
      )}
      <Text>{'   '}</Text>
      <Text color={isIdle ? 'gray' : 'green'}>{isIdle ? '○ idle' : '● live'}</Text>
      {stats.lastEventAt && (
        <Text dimColor>{`  ${timeAgo(now - stats.lastEventAt)} ago`}</Text>
      )}
    </Box>
  );
}

// ── Tab bar ──────────────────────────────────────────────────────────────────
function TabBar({
  focusedTab,
  openTab,
}: {
  focusedTab: 1 | 2 | 3 | 4;
  openTab: 1 | 2 | 3 | 4 | null;
}) {
  const tabs = [
    { id: 1 as const, label: 'Breakdown' },
    { id: 2 as const, label: 'History' },
    { id: 3 as const, label: 'Sessions' },
    { id: 4 as const, label: 'Transcripts' },
  ];

  return (
    <Box paddingX={1}>
      {tabs.map((tab) => {
        const isFocused = focusedTab === tab.id;
        const isOpen = openTab === tab.id;
        // open+focused → cyan bold; focused only → white bold (cursor); open only → cyan; rest → dim
        const color = isOpen ? 'cyan' : isFocused ? 'white' : undefined;
        const dim = !isFocused && !isOpen;
        return (
          <Box key={tab.id} marginRight={3}>
            <Text color={color} bold={isFocused} dimColor={dim}>
              {isFocused ? '›' : ' '}[{tab.id}] {tab.label}{isOpen ? ' ▾' : ''}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

// ── Breakdown panel ──────────────────────────────────────────────────────────
function BreakdownPanel({
  stats,
  series,
  ratePerSec,
}: {
  stats: SessionStats | null;
  series: number[];
  ratePerSec: number;
}) {
  return (
    <Box
      borderStyle="round"
      borderColor="green"
      paddingX={1}
      flexDirection="column"
      flexGrow={1}
      minWidth={42}
    >
      <Text bold color="green">
        {'Token breakdown'}
        <Text bold={false} color="green"> · live data</Text>
      </Text>

      {/* Sparkline */}
      {series.some((n) => n > 0) ? (
        <Box marginBottom={1} flexDirection="column">
          <Text>
            <Text dimColor>activity (last {SPARK_WIDTH}s)   peak </Text>
            <Text bold color="yellow">{fmtNumber(Math.max(...series))}</Text>
            <Text dimColor>/s</Text>
            {Math.round(ratePerSec) > 0 && (
              <>
                <Text dimColor>   avg </Text>
                <Text color="yellow">{fmtNumber(Math.round(ratePerSec))}</Text>
                <Text dimColor>/s</Text>
              </>
            )}
          </Text>
          <Text>
            {sparklineCells(series, SPARK_WIDTH).map((cell, i) => {
              const isCurrentSlot = i === SPARK_WIDTH - 1 && cell.intensity > 0;
              return (
                <Text
                  key={i}
                  color={isCurrentSlot ? 'white' : intensityColor(cell.intensity)}
                  bold={isCurrentSlot}
                >
                  {cell.char}
                </Text>
              );
            })}
          </Text>
          <Text dimColor>{axisLabel(SPARK_WIDTH)}</Text>
        </Box>
      ) : (
        <Box marginBottom={1}>
          <Text dimColor>○ idle — no activity in the last {SPARK_WIDTH}s</Text>
        </Box>
      )}

      {!stats ? (
        <Text dimColor>No session data yet.</Text>
      ) : (
        (() => {
          const u = stats.totals;
          const max = Math.max(
            1,
            u.input_tokens,
            u.output_tokens,
            u.cache_creation_input_tokens,
            u.cache_read_input_tokens,
          );
          const total = totalTokens(u);
          const model = stats.lastModel ?? '';
          const cacheDenom = u.input_tokens + u.cache_read_input_tokens;
          const hitRatio = cacheDenom > 0 ? u.cache_read_input_tokens / cacheDenom : null;
          return (
            <Box flexDirection="column">
              <BarRow
                label="Input    "
                value={u.input_tokens}
                max={max}
                total={total}
                color="cyan"
                cost={categoryCostUSD(model, 'input', u.input_tokens)}
              />
              <BarRow
                label="Output   "
                value={u.output_tokens}
                max={max}
                total={total}
                color="green"
                cost={categoryCostUSD(model, 'output', u.output_tokens)}
              />
              <BarRow
                label="C. write "
                value={u.cache_creation_input_tokens}
                max={max}
                total={total}
                color="yellow"
                cost={categoryCostUSD(model, 'cacheWrite', u.cache_creation_input_tokens)}
              />
              <BarRow
                label="C. read  "
                value={u.cache_read_input_tokens}
                max={max}
                total={total}
                color="magenta"
                cost={categoryCostUSD(model, 'cacheRead', u.cache_read_input_tokens)}
              />
              {hitRatio !== null && (
                <Box marginTop={1}>
                  <Text>
                    <Text bold>Cache hit</Text>
                    <Text dimColor> · </Text>
                    <Text color={hitRatio > 0.9 ? 'green' : hitRatio > 0.6 ? 'yellow' : 'red'}>
                      {(hitRatio * 100).toFixed(1)}%
                    </Text>
                    <Text color={hitRatio > 0.9 ? 'green' : hitRatio > 0.6 ? 'yellow' : 'red'}>
                      {hitRatio > 0.9 ? '  ✓ excellent' : hitRatio > 0.6 ? '  ⚠ degraded' : '  ✗ poor'}
                    </Text>
                  </Text>
                </Box>
              )}
              {Object.keys(stats.byModel).length > 1 && (
                <Box marginTop={1} flexDirection="column">
                  <Text dimColor>By model</Text>
                  {Object.entries(stats.byModel).map(([m, mu]) => {
                    const c = estimateCostUSD(m, mu);
                    return (
                      <Text key={m}>
                        <Text color="cyan">{shortModel(m)}</Text>
                        <Text dimColor>  Σ </Text>
                        <Text>{fmtNumber(totalTokens(mu))}</Text>
                        {c !== null && (
                          <>
                            <Text dimColor>  ~</Text>
                            <Text>{fmtUSD(c)}</Text>
                          </>
                        )}
                      </Text>
                    );
                  })}
                </Box>
              )}
            </Box>
          );
        })()
      )}
    </Box>
  );
}

function BarRow({
  label,
  value,
  max,
  total,
  color,
  cost,
}: {
  label: string;
  value: number;
  max: number;
  total: number;
  color: string;
  cost: number | null;
}) {
  const pct = total > 0 ? (value / total) * 100 : 0;
  return (
    <Text>
      <Text bold>{label}</Text>
      <Text color={color}>{bar(value / max, BAR_WIDTH)}</Text>
      <Text>  {fmtNumber(value).padStart(7, ' ')}</Text>
      <Text dimColor>{`  ${pct.toFixed(1).padStart(5, ' ')}%`}</Text>
      {cost !== null && <Text dimColor>{`  ~${fmtUSD(cost)}`}</Text>}
    </Text>
  );
}

// ── History panel ────────────────────────────────────────────────────────────
function HistoryPanel({ history }: { history: HistorySnapshot | null }) {
  return (
    <Box borderStyle="round" borderColor="blue" paddingX={1} flexDirection="column" width="100%">
      <Text bold color="blue">
        {'Usage history'}
        <Text bold={false} color="blue"> · refreshes every 60s</Text>
      </Text>
      {!history ? (
        <Text dimColor>Scanning ~/.claude/projects…</Text>
      ) : history.scannedFiles === 0 ? (
        <Text dimColor>No transcripts found.</Text>
      ) : (
        <>
          <HistoryRow label="" today="Today" d7="7d" d30="30d" dim />
          <HistoryRow
            label="Tokens "
            today={fmtNumber(bucketTokens(history.today))}
            d7={fmtNumber(bucketTokens(history.d7))}
            d30={fmtNumber(bucketTokens(history.d30))}
          />
          <HistoryRow
            label="Cost~  "
            today={fmtCost(bucketCostUSD(history.today))}
            d7={fmtCost(bucketCostUSD(history.d7))}
            d30={fmtCost(bucketCostUSD(history.d30))}
          />
          <HistoryRow
            label="Sessions"
            today={String(history.today.sessions.size)}
            d7={String(history.d7.sessions.size)}
            d30={String(history.d30.sessions.size)}
          />
          <HistoryRow
            label="Top model"
            today={fmtTopModel(history.today)}
            d7={fmtTopModel(history.d7)}
            d30={fmtTopModel(history.d30)}
          />
          <Box marginTop={1}>
            <Text dimColor>
              {`scanned ${history.scannedFiles} transcripts`}
              {history.oldestMtimeMs !== null &&
                ` · data since ${fmtDate(history.oldestMtimeMs)} (${daysAgo(
                  history.oldestMtimeMs,
                  history.generatedAt,
                )} days)`}
            </Text>
          </Box>
        </>
      )}
    </Box>
  );
}

function fmtDate(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function daysAgo(from: number, to: number): number {
  return Math.max(0, Math.floor((to - from) / 86_400_000));
}

function HistoryRow({
  label,
  today,
  d7,
  d30,
  dim,
}: {
  label: string;
  today: string;
  d7: string;
  d30: string;
  dim?: boolean;
}) {
  const col = (s: string) => s.padEnd(14, ' ');
  return (
    <Text dimColor={dim}>
      <Text bold>{label.padEnd(10, ' ')}</Text>
      <Text>{col(today)}</Text>
      <Text>{col(d7)}</Text>
      <Text>{col(d30)}</Text>
    </Text>
  );
}

function fmtCost(c: number | null): string {
  return c === null ? '—' : fmtUSD(c);
}

function fmtTopModel(b: BucketStats): string {
  const m = bucketTopModel(b);
  return m ? shortModel(m) : '—';
}

// ── Today's sessions panel ───────────────────────────────────────────────────
function TodaySessionsPanel({ sessions, now }: { sessions: SessionSummary[]; now: number }) {
  return (
    <Box borderStyle="round" borderColor="blue" paddingX={1} flexDirection="column" width="100%">
      <Text bold color="blue">
        {"Today's sessions"}
        <Text bold={false} color="blue">{` · ${sessions.length} ${plural(sessions.length, 'session', 'sessions')} today`}</Text>
      </Text>
      {sessions.map((s) => {
        const tokens = Object.values(s.byModel).reduce(
          (acc, u) => acc + totalTokens(u),
          0,
        );
        const cost = Object.entries(s.byModel).reduce<number | null>((acc, [m, u]) => {
          const c = estimateCostUSD(m, u);
          if (c === null) return acc;
          return (acc ?? 0) + c;
        }, null);
        const topModel = Object.entries(s.byModel).reduce<string | null>(
          (best, [m, u]) =>
            best === null || totalTokens(u) > totalTokens(s.byModel[best] ?? {} as any)
              ? m
              : best,
          null,
        );
        const duration =
          s.startedAt !== null && s.endedAt !== null
            ? fmtDuration(s.endedAt - s.startedAt)
            : null;

        return (
          <Text key={s.sessionId}>
            <Text color={s.isActive ? 'green' : 'gray'}>{s.isActive ? '▶ ' : '  '}</Text>
            <Text bold={s.isActive}>
              {s.startedAt ? fmtTime(s.startedAt) : '??:??'}
            </Text>
            <Text dimColor>{'  '}</Text>
            <Text wrap="truncate-middle" dimColor={!s.isActive}>
              {OPTS.reveal ? (s.cwd ?? '—') : displayCwd(s.cwd)}
            </Text>
            <Text dimColor>{'  '}</Text>
            <Text color="cyan">{topModel ? shortModel(topModel) : '—'}</Text>
            <Text dimColor>{'  '}</Text>
            <Text>{fmtNumber(tokens)}</Text>
            {cost !== null && <Text dimColor>{`  ~${fmtUSD(cost)}`}</Text>}
            {duration && <Text dimColor>{`  ${duration}`}</Text>}
            {s.isActive && <Text color="green"> active</Text>}
          </Text>
        );
      })}
    </Box>
  );
}

function fmtDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${totalSec}s`;
}

// ── Transcripts panel ────────────────────────────────────────────────────────
function TranscriptsPanel({
  transcripts,
  activePath,
  now,
}: {
  transcripts: { path: string; mtimeMs: number; cwd: string }[];
  activePath: string | null;
  now: number;
}) {
  return (
    <Box borderStyle="round" borderColor="gray" paddingX={1} flexDirection="column" width="100%">
      <Text bold>Recent transcripts</Text>
      {transcripts.length === 0 ? (
        <Text dimColor>None found under ~/.claude/projects</Text>
      ) : (
        transcripts.map((t) => {
          const isActive = t.path === activePath;
          return (
            <Text key={t.path}>
              <Text color={isActive ? 'green' : 'gray'}>{isActive ? '▶ ' : '  '}</Text>
              <Text dimColor={!isActive} wrap="truncate-middle">
                {OPTS.reveal ? t.cwd : displayCwd(t.cwd)}
              </Text>
              <Text dimColor>{`   ${timeAgo(now - t.mtimeMs)}`}</Text>
            </Text>
          );
        })
      )}
    </Box>
  );
}

// ── helpers ──────────────────────────────────────────────────────────────────
function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <Text>
      <Text bold>{k}</Text>
      <Text dimColor> · </Text>
      {v}
    </Text>
  );
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const isToday =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const time = `${h}:${m}`;
  if (isToday) return time;
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day} ${time}`;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/**
 * Like anonymizePath, but distinguishes the bare home directory from "no
 * path" — a transcript whose cwd is $HOME would otherwise show as a lonely
 * `~`, which looks like a bug.
 */
function displayCwd(cwd: string | undefined): string {
  const out = anonymizePath(cwd);
  if (out === '~') return '~ (home)';
  return out;
}

function intensityColor(ratio: number): string {
  if (ratio <= 0) return 'gray';
  if (ratio < 0.34) return 'green';
  if (ratio < 0.67) return 'yellow';
  return 'red';
}

function axisLabel(width: number): string {
  const left = `-${width}s`;
  const right = 'now';
  const gap = Math.max(1, width - left.length - right.length);
  return `${left}${' '.repeat(gap)}${right}`;
}

function shortModel(m: string): string {
  return m.replace(/^claude-/, '').replace(/-20\d{6}/, '').replace(/-\d{8}$/, '');
}

function timeAgo(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

render(<App />);
