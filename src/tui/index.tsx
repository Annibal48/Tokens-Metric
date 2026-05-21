#!/usr/bin/env node
import React, { useEffect, useState } from 'react';
import { render, Box, Text, useApp, useInput } from 'ink';
import { findActiveTranscript, listTranscripts } from '../core/parser.js';
import { tailTranscript, type TailHandle } from '../core/tailer.js';
import { detectAuth } from '../core/detect.js';
import { estimateCostUSD, fmtNumber, fmtUSD } from '../core/format.js';
import { totalTokens, type AuthInfo, type SessionStats } from '../core/types.js';

const RESCAN_MS = 3_000;

function App() {
  const { exit } = useApp();
  const [auth] = useState<AuthInfo>(() => detectAuth());
  const [stats, setStats] = useState<SessionStats | null>(null);
  const [transcriptPath, setTranscriptPath] = useState<string | null>(null);
  const [rate, setRate] = useState<number>(0); // tokens per minute (rolling)
  const [now, setNow] = useState<number>(Date.now());

  useInput((input, key) => {
    if (input === 'q' || key.escape || (key.ctrl && input === 'c')) exit();
  });

  // Refresh "now" once per second so the time-since field ticks.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Track active transcript; reattach when a newer one appears.
  useEffect(() => {
    let handle: TailHandle | null = null;
    let cancelled = false;
    let lastTotal = 0;
    let lastSampleAt = Date.now();

    async function attach(path: string) {
      handle?.stop().catch(() => undefined);
      setTranscriptPath(path);
      handle = await tailTranscript(path);
      if (cancelled) {
        handle.stop();
        return;
      }
      handle.onUpdate((s) => {
        // Rolling tokens/min using delta since last update.
        const tot = totalTokens(s.totals);
        const dt = (Date.now() - lastSampleAt) / 60_000;
        if (dt > 0) {
          const delta = Math.max(0, tot - lastTotal);
          if (delta > 0) setRate(delta / dt);
        }
        lastTotal = tot;
        lastSampleAt = Date.now();
        setStats({ ...s });
      });
    }

    async function rescan() {
      const active = findActiveTranscript();
      if (active && active.path !== transcriptPath) {
        await attach(active.path);
      }
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
      <Box marginTop={1} flexDirection="column">
        {!stats ? (
          <Text dimColor>Waiting for a Claude Code session… (open Claude and start chatting)</Text>
        ) : (
          <SessionPanel stats={stats} rate={rate} now={now} />
        )}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text bold>Recent transcripts</Text>
        {transcripts.length === 0 ? (
          <Text dimColor>None found under ~/.claude/projects</Text>
        ) : (
          transcripts.map((t) => (
            <Text key={t.path} dimColor={t.path !== transcriptPath}>
              {t.path === transcriptPath ? '▶ ' : '  '}
              {t.cwd}  <Text dimColor>({timeAgo(now - t.mtimeMs)})</Text>
            </Text>
          ))
        )}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Press q to quit · refresh ~live · pricing is API-equivalent, not your real bill</Text>
      </Box>
    </Box>
  );
}

function Header({ auth }: { auth: AuthInfo }) {
  const color = auth.installed && auth.loggedIn ? 'green' : auth.installed ? 'yellow' : 'red';
  return (
    <Box flexDirection="column">
      <Text bold>tokens-metric</Text>
      <Text>
        <Text color={color}>●</Text>{' '}
        {auth.installed ? 'Claude Code detected' : 'Claude Code NOT detected'} ·{' '}
        {authLabel(auth)}
      </Text>
      {auth.hint && <Text dimColor>{auth.hint}</Text>}
    </Box>
  );
}

function SessionPanel({ stats, rate, now }: { stats: SessionStats; rate: number; now: number }) {
  const model = stats.lastModel ?? 'unknown';
  const tot = totalTokens(stats.totals);
  const cost = estimateCostUSD(model, stats.totals);
  const since = stats.lastEventAt ? now - stats.lastEventAt : null;

  return (
    <Box flexDirection="column">
      <Text>
        <Text bold>Model:</Text> {model}   <Text bold>Messages:</Text> {stats.messageCount}
        {since !== null && (
          <>
            {'   '}
            <Text bold>Last event:</Text> <Text>{timeAgo(since)} ago</Text>
          </>
        )}
      </Text>
      <Text>
        <Text bold>cwd:</Text> <Text dimColor>{stats.cwd ?? '—'}</Text>
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Row label="Input        " value={stats.totals.input_tokens} />
        <Row label="Output       " value={stats.totals.output_tokens} />
        <Row label="Cache write  " value={stats.totals.cache_creation_input_tokens} />
        <Row label="Cache read   " value={stats.totals.cache_read_input_tokens} />
        <Text>
          <Text bold>Total        </Text>
          <Text color="cyan">{fmtNumber(tot)}</Text>
          {cost !== null && <Text dimColor>   (~{fmtUSD(cost)} API-equivalent)</Text>}
        </Text>
        <Text dimColor>Rate: ~{fmtNumber(Math.round(rate))} tok/min</Text>
      </Box>
    </Box>
  );
}

function Row({ label, value }: { label: string; value: number }) {
  return (
    <Text>
      <Text bold>{label}</Text>
      {fmtNumber(value)}
    </Text>
  );
}

function authLabel(a: AuthInfo): string {
  const method =
    a.authMethod === 'api-key'
      ? 'API key'
      : a.authMethod === 'oauth-subscription'
        ? 'subscription'
        : a.authMethod === 'none'
          ? 'none'
          : 'unknown';
  const plan =
    a.planHint === 'team-or-enterprise'
      ? 'Team/Enterprise'
      : a.planHint === 'paid'
        ? 'Pro or Max'
        : a.planHint === 'free'
          ? 'Free'
          : a.planHint === 'api'
            ? 'pay-per-token'
            : '?';
  const idSuffix = a.userIdShort ? ` · user ${a.userIdShort}` : '';
  return `auth: ${method} · plan: ${plan}${idSuffix}`;
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
