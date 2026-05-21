#!/usr/bin/env node
import React, { useEffect, useRef, useState } from 'react';
import { render, Box, Text, useApp, useInput } from 'ink';
import { findActiveTranscript, listTranscripts } from '../core/parser.js';
import { tailTranscript, type TailHandle } from '../core/tailer.js';
import { detectAuth } from '../core/detect.js';
import { estimateCostUSD, fmtNumber, fmtUSD } from '../core/format.js';
import { totalTokens, type AuthInfo, type SessionStats } from '../core/types.js';
import { bar, sparkline } from './bars.js';

const RESCAN_MS = 3_000;
const SPARK_WIDTH = 32;
const BAR_WIDTH = 20;

function App() {
  const { exit } = useApp();
  const [auth] = useState<AuthInfo>(() => detectAuth());
  const [stats, setStats] = useState<SessionStats | null>(null);
  const [transcriptPath, setTranscriptPath] = useState<string | null>(null);
  const [rate, setRate] = useState<number>(0);
  const [series, setSeries] = useState<number[]>(() => Array(SPARK_WIDTH).fill(0));
  const [now, setNow] = useState<number>(Date.now());
  const lastTotalRef = useRef(0);
  const lastSampleAtRef = useRef(Date.now());

  // useInput requires raw mode (interactive TTY). Skip it when stdin is piped
  // or otherwise non-interactive, so `node dist/tui/index.js | cat` still
  // renders instead of crashing.
  const interactive = Boolean(process.stdin.isTTY);
  if (interactive) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useInput((input, key) => {
      if (input === 'q' || key.escape || (key.ctrl && input === 'c')) exit();
    });
  }

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
      handle.onUpdate((s) => {
        const tot = totalTokens(s.totals);
        const delta = Math.max(0, tot - lastTotalRef.current);
        const dt = (Date.now() - lastSampleAtRef.current) / 60_000;
        if (dt > 0 && delta > 0) setRate(delta / dt);
        if (delta > 0) {
          setSeries((arr) => {
            const next = arr.slice();
            next[next.length - 1] = (next[next.length - 1] ?? 0) + delta;
            return next;
          });
        }
        lastTotalRef.current = tot;
        lastSampleAtRef.current = Date.now();
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

  const transcripts = listTranscripts().slice(0, 5);

  return (
    <Box flexDirection="column" padding={1}>
      <Header auth={auth} />

      <Box marginTop={1} flexDirection="row" gap={1}>
        <SessionPanel stats={stats} rate={rate} now={now} series={series} />
        <BreakdownPanel stats={stats} />
      </Box>

      <Box marginTop={1}>
        <TranscriptsPanel
          transcripts={transcripts}
          activePath={transcriptPath}
          now={now}
        />
      </Box>

      <Box marginTop={1}>
        <Text dimColor>
          <Text color="magenta">q</Text> quit ·{' '}
          <Text color="magenta">live</Text> tail of ~/.claude/projects · pricing is{' '}
          <Text italic>API-equivalent</Text>, not your real bill on a subscription
        </Text>
      </Box>
    </Box>
  );
}

// ── Header ───────────────────────────────────────────────────────────────────
function Header({ auth }: { auth: AuthInfo }) {
  const ok = auth.installed && auth.loggedIn;
  const dot = ok ? 'green' : auth.installed ? 'yellow' : 'red';
  const planChip = planChipFor(auth);

  return (
    <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
      <Box>
        <Text bold color="cyan">▌ tokens-metric </Text>
        <Text dimColor>v0.1.0 — real-time Claude Code usage</Text>
      </Box>
      <Box marginTop={0}>
        <Text>
          <Text color={dot}>●</Text>{' '}
          {auth.installed ? 'Claude Code detected' : 'Claude Code NOT detected'}
          {'   '}
          <Text {...planChip.style}>{planChip.label}</Text>
          {auth.userIdShort && <Text dimColor>{`   user ${auth.userIdShort}`}</Text>}
        </Text>
      </Box>
      {auth.hint && (
        <Box>
          <Text dimColor>↳ {auth.hint}</Text>
        </Box>
      )}
    </Box>
  );
}

function planChipFor(auth: AuthInfo): { label: string; style: { color?: string; bold?: boolean; dimColor?: boolean } } {
  if (!auth.loggedIn) return { label: ' LOGGED-OUT ', style: { color: 'red', bold: true } };
  switch (auth.planHint) {
    case 'api':
      return { label: ' API ', style: { color: 'yellow', bold: true } };
    case 'team-or-enterprise':
      return { label: ' TEAM / ENTERPRISE ', style: { color: 'magenta', bold: true } };
    case 'paid':
      return { label: ' PRO / MAX ', style: { color: 'green', bold: true } };
    case 'free':
      return { label: ' FREE ', style: { color: 'blue', bold: true } };
    default:
      return { label: ' SUBSCRIPTION ', style: { color: 'cyan', bold: true } };
  }
}

// ── Session panel ────────────────────────────────────────────────────────────
function SessionPanel({
  stats,
  rate,
  now,
  series,
}: {
  stats: SessionStats | null;
  rate: number;
  now: number;
  series: number[];
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
      <Text bold color="green">Active session</Text>
      {!stats ? (
        <Text dimColor>Waiting for a Claude Code session…</Text>
      ) : (
        <>
          <KV k="Model" v={<Text color="cyan">{stats.lastModel ?? '—'}</Text>} />
          <KV k="Msgs " v={<Text>{stats.messageCount}</Text>} />
          <KV
            k="Last "
            v={
              stats.lastEventAt ? (
                <Text>{timeAgo(now - stats.lastEventAt)} ago</Text>
              ) : (
                <Text dimColor>—</Text>
              )
            }
          />
          <KV
            k="cwd  "
            v={<Text dimColor wrap="truncate-middle">{stats.cwd ?? '—'}</Text>}
          />

          <Box marginTop={1} flexDirection="column">
            <Text>
              <Text bold>Σ </Text>
              <Text color="cyan" bold>
                {fmtNumber(totalTokens(stats.totals))}
              </Text>
              <Text dimColor> tokens</Text>
            </Text>
            {(() => {
              const cost = estimateCostUSD(stats.lastModel ?? '', stats.totals);
              return cost !== null ? (
                <Text dimColor>~{fmtUSD(cost)} API-equivalent</Text>
              ) : null;
            })()}
            <Text>
              <Text bold>~ </Text>
              <Text color="yellow">{fmtNumber(Math.round(rate))}</Text>
              <Text dimColor> tok/min</Text>
            </Text>
          </Box>

          <Box marginTop={1} flexDirection="column">
            <Text dimColor>activity (last {SPARK_WIDTH}s)</Text>
            <Text color="yellow">{sparkline(series, SPARK_WIDTH)}</Text>
          </Box>
        </>
      )}
    </Box>
  );
}

// ── Breakdown panel ──────────────────────────────────────────────────────────
function BreakdownPanel({ stats }: { stats: SessionStats | null }) {
  return (
    <Box
      borderStyle="round"
      borderColor="blue"
      paddingX={1}
      flexDirection="column"
      flexGrow={1}
      minWidth={42}
    >
      <Text bold color="blue">Token breakdown</Text>
      {!stats ? (
        <Text dimColor>No data yet.</Text>
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
          return (
            <Box flexDirection="column">
              <BarRow label="Input    " value={u.input_tokens} max={max} color="cyan" />
              <BarRow label="Output   " value={u.output_tokens} max={max} color="green" />
              <BarRow label="C. write " value={u.cache_creation_input_tokens} max={max} color="yellow" />
              <BarRow label="C. read  " value={u.cache_read_input_tokens} max={max} color="magenta" />
              <Box marginTop={1} flexDirection="column">
                <Text dimColor>By model</Text>
                {Object.entries(stats.byModel).map(([m, mu]) => (
                  <Text key={m}>
                    <Text color="cyan">{shortModel(m)}</Text>
                    <Text dimColor>  Σ </Text>
                    <Text>{fmtNumber(totalTokens(mu))}</Text>
                  </Text>
                ))}
              </Box>
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
  color,
}: {
  label: string;
  value: number;
  max: number;
  color: string;
}) {
  return (
    <Text>
      <Text bold>{label}</Text>
      <Text color={color}>{bar(value / max, BAR_WIDTH)}</Text>
      <Text>  {fmtNumber(value)}</Text>
    </Text>
  );
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
                {t.cwd}
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
