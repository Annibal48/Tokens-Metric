export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export interface UsageByModel extends Usage {
  model: string;
}

export interface SessionStats {
  sessionId: string;
  transcriptPath: string;
  cwd?: string;
  lastModel?: string;
  startedAt?: number;
  lastEventAt?: number;
  totals: Usage;
  byModel: Record<string, Usage>;
  messageCount: number;
}

export type AuthMethod = 'oauth-subscription' | 'api-key' | 'none' | 'unknown';
export type PlanHint =
  | 'api'
  | 'free'
  | 'paid'
  | 'team-or-enterprise'
  | 'unknown';

export interface AuthInfo {
  installed: boolean;
  binPath?: string;
  loggedIn: boolean;
  authMethod: AuthMethod;
  /** Best-effort plan guess. NEVER authoritative — local signals only. */
  planHint: PlanHint;
  /** Human-readable explanation of why we picked planHint / authMethod. */
  hint?: string;
  /** Anonymous user identifier when present (hashed by Claude Code, safe to surface). */
  userIdShort?: string;
}

export const EMPTY_USAGE = (): Usage => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
});

export function addUsage(a: Usage, b: Partial<Usage>): Usage {
  return {
    input_tokens: a.input_tokens + (b.input_tokens ?? 0),
    output_tokens: a.output_tokens + (b.output_tokens ?? 0),
    cache_creation_input_tokens:
      a.cache_creation_input_tokens + (b.cache_creation_input_tokens ?? 0),
    cache_read_input_tokens:
      a.cache_read_input_tokens + (b.cache_read_input_tokens ?? 0),
  };
}

export function totalTokens(u: Usage): number {
  return (
    u.input_tokens +
    u.output_tokens +
    u.cache_creation_input_tokens +
    u.cache_read_input_tokens
  );
}
