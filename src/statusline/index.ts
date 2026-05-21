#!/usr/bin/env node
import { aggregateTranscript, findActiveTranscript } from '../core/parser.js';
import { detectAuth } from '../core/detect.js';
import { estimateCostUSD, fmtNumber, fmtUSD } from '../core/format.js';
import { totalTokens } from '../core/types.js';
import { HELP_TEXT, parseArgs } from '../core/args.js';

const OPTS = parseArgs(process.argv);
if (OPTS.help) {
  process.stdout.write(HELP_TEXT);
  process.exit(0);
}

/**
 * One-shot status line. Reads whatever JSONL is currently the most recent
 * transcript, aggregates it, and prints a single line. Exits 0 always so
 * Claude Code's statusLine doesn't blank out on errors.
 */
async function main() {
  try {
    const active = findActiveTranscript();
    const auth = detectAuth();

    if (!active) {
      process.stdout.write(authBadge(auth) + ' · no active session');
      return;
    }

    const s = await aggregateTranscript(active.path);
    const model = s.lastModel ?? 'unknown';
    const tot = totalTokens(s.totals);
    const cost = estimateCostUSD(model, s.totals);
    const costStr = cost !== null ? ` · ~${fmtUSD(cost)} API-eq` : '';

    const line =
      `${authBadge(auth)} ` +
      `${shortModel(model)} │ ` +
      `in ${fmtNumber(s.totals.input_tokens)} · ` +
      `out ${fmtNumber(s.totals.output_tokens)} · ` +
      `cache ${fmtNumber(s.totals.cache_read_input_tokens + s.totals.cache_creation_input_tokens)} ` +
      `│ Σ ${fmtNumber(tot)}` +
      costStr;

    process.stdout.write(line);
  } catch (err) {
    process.stdout.write('tokens-metric · err');
  }
}

function shortModel(m: string): string {
  return m
    .replace(/^claude-/, '')
    .replace(/-20\d{6}/, '')
    .replace(/-\d{8}$/, '');
}

function authBadge(a: ReturnType<typeof detectAuth>): string {
  if (!a.installed) return '⚠ no-cc';
  if (!a.loggedIn) return '🔒 logged-out';
  switch (a.planHint) {
    case 'api':
      return '🔑 api';
    case 'team-or-enterprise':
      return '🏢 team';
    case 'paid':
      return '💎 paid';
    case 'free':
      return '🆓 free';
    default:
      return '🧠 sub';
  }
}

main();
