import { homedir } from 'node:os';

/**
 * Replace the user's home directory with `~` so screenshots posted publicly
 * don't reveal the macOS username. Returns the input untouched if it doesn't
 * start with $HOME.
 */
export function anonymizePath(p: string | undefined): string {
  if (!p) return '—';
  const home = homedir();
  if (p === home) return '~';
  if (p.startsWith(home + '/')) return '~' + p.slice(home.length);
  return p;
}

/**
 * Mask all but the first 2 characters of the user ID with dots, so a
 * screenshot still hints at "I'm logged in" without exposing the full hash.
 * Pass `reveal` to bypass.
 */
export function maskUserId(id: string | undefined, reveal: boolean): string | undefined {
  if (!id) return undefined;
  if (reveal) return id;
  if (id.length <= 2) return '●●●●●●●●';
  return id.slice(0, 2) + '●●●●●●';
}
