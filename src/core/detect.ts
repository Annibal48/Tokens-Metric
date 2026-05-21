import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AuthInfo } from './types.js';

export function claudeHome(): string {
  return join(homedir(), '.claude');
}

export function detectAuth(): AuthInfo {
  let binPath: string | undefined;
  try {
    binPath = execSync('command -v claude', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    binPath = undefined;
  }
  const installed = Boolean(binPath) || existsSync(claudeHome());

  if (process.env.ANTHROPIC_API_KEY) {
    return {
      installed,
      binPath,
      loggedIn: true,
      authMethod: 'api-key',
      hint: 'Using ANTHROPIC_API_KEY (API billing, pay-per-token).',
    };
  }

  const credPath = join(claudeHome(), '.credentials.json');
  if (existsSync(credPath)) {
    try {
      const raw = readFileSync(credPath, 'utf8');
      const looksOauth = raw.includes('access_token') || raw.includes('refresh_token');
      return {
        installed,
        binPath,
        loggedIn: true,
        authMethod: looksOauth ? 'oauth-subscription' : 'unknown',
        hint: looksOauth
          ? 'OAuth credentials present (Pro/Max/Team — plan not distinguishable locally).'
          : 'Credentials file present but format unrecognized.',
      };
    } catch {
      // fallthrough
    }
  }

  return {
    installed,
    binPath,
    loggedIn: false,
    authMethod: 'none',
    hint: installed
      ? 'Claude Code looks installed but no auth was detected. Run `claude` to log in.'
      : 'Claude Code does not appear to be installed.',
  };
}
