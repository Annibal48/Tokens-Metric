import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AuthInfo, PlanHint } from './types.js';

export function claudeHome(): string {
  return join(homedir(), '.claude');
}

export function claudeConfigPath(): string {
  return join(homedir(), '.claude.json');
}

export function codexHome(): string {
  return join(homedir(), '.codex');
}

export function codexSessionsDir(): string {
  return join(codexHome(), 'sessions');
}

export function isCodexInstalled(): boolean {
  return existsSync(codexHome());
}

interface ClaudeConfigSubset {
  userID?: unknown;
  opusProMigrationComplete?: unknown;
  sonnet1m45MigrationComplete?: unknown;
  cachedExtraUsageDisabledReason?: unknown;
  firstStartTime?: unknown;
}

/**
 * Detect whether Claude Code is installed, the user is logged in, and best-
 * effort what plan they're on. All signals are LOCAL and BEST-EFFORT — we
 * never claim authority over a plan tier Anthropic hasn't told us about.
 */
export function detectAuth(): AuthInfo {
  const binPath = whichClaude();
  const installed =
    Boolean(binPath) || existsSync(claudeHome()) || existsSync(claudeConfigPath());

  // 1. API key takes precedence over OAuth (Claude Code itself prefers it).
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      installed,
      binPath,
      loggedIn: true,
      authMethod: 'api-key',
      planHint: 'api',
      hint: 'ANTHROPIC_API_KEY is set — pay-per-token API billing.',
    };
  }

  // 2. OAuth / subscription: ~/.claude.json holds a `userID` once logged in.
  //    The actual access token lives elsewhere (Keychain on macOS), but we
  //    don't need it — userID is sufficient proof of login.
  const cfg = readClaudeConfig();
  const userId = typeof cfg?.userID === 'string' ? cfg.userID : '';

  if (userId) {
    const planHint = inferPlanHint(cfg);
    return {
      installed,
      binPath,
      loggedIn: true,
      authMethod: 'oauth-subscription',
      planHint,
      userIdShort: userId.slice(0, 8),
      hint: planHintExplanation(planHint, cfg),
    };
  }

  // 3. Installed but not logged in.
  if (installed) {
    return {
      installed,
      binPath,
      loggedIn: false,
      authMethod: 'none',
      planHint: 'unknown',
      hint: 'Claude Code is installed but you are not logged in. Run `claude` to log in.',
    };
  }

  return {
    installed: false,
    loggedIn: false,
    authMethod: 'none',
    planHint: 'unknown',
    hint: 'Claude Code does not appear to be installed.',
  };
}

function whichClaude(): string | undefined {
  try {
    return execSync('command -v claude', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim() || undefined;
  } catch {
    return undefined;
  }
}

function readClaudeConfig(): ClaudeConfigSubset | null {
  const p = claudeConfigPath();
  if (!existsSync(p)) return null;
  try {
    // The file is ~22KB and JSON — parse it once.
    return JSON.parse(readFileSync(p, 'utf8')) as ClaudeConfigSubset;
  } catch {
    return null;
  }
}

/**
 * Heuristic plan inference. These signals come from `~/.claude.json` flags
 * that Claude Code itself writes after migrations/feature gates run. They
 * are correlational, not authoritative — Anthropic could change them at any
 * release.
 *
 * - `opusProMigrationComplete: true` is set for accounts that have been
 *   migrated to the Opus-on-Pro rollout — strong signal of a paid plan
 *   (Pro / Max / Team / Enterprise).
 * - `cachedExtraUsageDisabledReason: "org_level_disabled"` is set on
 *   Team/Enterprise accounts whose org admin has disabled extra usage. It's
 *   a strong hint of an org-managed seat.
 */
function inferPlanHint(cfg: ClaudeConfigSubset | null): PlanHint {
  if (!cfg) return 'unknown';
  if (cfg.cachedExtraUsageDisabledReason === 'org_level_disabled') {
    return 'team-or-enterprise';
  }
  if (cfg.opusProMigrationComplete === true) return 'paid';
  // Logged in but no Opus-Pro migration flag → most likely Free, but not
  // guaranteed (could be a fresh paid account before migration).
  return 'free';
}

function planHintExplanation(plan: PlanHint, cfg: ClaudeConfigSubset | null): string {
  switch (plan) {
    case 'team-or-enterprise':
      return 'Org-managed account — likely Team or Enterprise.';
    case 'paid':
      return 'Paid plan likely — Pro or Max (not distinguishable locally).';
    case 'free':
      return cfg
        ? 'Logged in. No paid-plan signals found — likely Free.'
        : 'Logged in.';
    case 'api':
      return 'Using API key — pay-per-token.';
    case 'unknown':
    default:
      return 'Plan tier not determinable from local signals.';
  }
}
