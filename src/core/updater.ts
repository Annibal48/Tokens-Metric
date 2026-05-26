import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CACHE_PATH = () => join(homedir(), '.tokens-metric', 'update-check.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const REGISTRY_URL = 'https://registry.npmjs.org/tokens-metric/latest';

interface Cache {
  checkedAt: number;
  latestVersion: string;
}

function readCache(): Cache | null {
  try {
    const raw = readFileSync(CACHE_PATH(), 'utf8');
    const c = JSON.parse(raw) as Cache;
    if (typeof c.checkedAt !== 'number' || typeof c.latestVersion !== 'string') return null;
    return c;
  } catch {
    return null;
  }
}

function writeCache(latestVersion: string): void {
  try {
    const dir = join(homedir(), '.tokens-metric');
    mkdirSync(dir, { recursive: true });
    writeFileSync(CACHE_PATH(), JSON.stringify({ checkedAt: Date.now(), latestVersion }), 'utf8');
  } catch {
    // ignore
  }
}

function isNewer(latest: string, current: string): boolean {
  const parse = (v: string) => v.replace(/^v/, '').split('.').map(Number);
  const [lMaj, lMin, lPat] = parse(latest);
  const [cMaj, cMin, cPat] = parse(current);
  if (lMaj !== cMaj) return (lMaj ?? 0) > (cMaj ?? 0);
  if (lMin !== cMin) return (lMin ?? 0) > (cMin ?? 0);
  return (lPat ?? 0) > (cPat ?? 0);
}

/** Write the cache so the next startup skips the network call and shows no prompt. */
export function markUpToDate(version: string): void {
  writeCache(version);
}

/**
 * Checks npm registry for a newer version. Non-blocking — uses a 24h cache
 * so most startups skip the network call entirely.
 *
 * Returns the latest version string if an update is available, null otherwise.
 */
export async function checkForUpdate(currentVersion: string): Promise<string | null> {
  try {
    const cached = readCache();
    let latestVersion: string;

    if (cached && Date.now() - cached.checkedAt < CACHE_TTL_MS) {
      latestVersion = cached.latestVersion;
    } else {
      const res = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(5_000) });
      if (!res.ok) return null;
      const data = await res.json() as { version: string };
      latestVersion = data.version;
      writeCache(latestVersion);
    }

    return isNewer(latestVersion, currentVersion) ? latestVersion : null;
  } catch {
    return null;
  }
}
