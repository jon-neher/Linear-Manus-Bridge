import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const STORE_PATH = join(process.cwd(), '.oauth-states.json');

// Map of state token -> timestamp (ms)
type StateStore = Record<string, number>;

function load(): StateStore {
  if (!existsSync(STORE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(STORE_PATH, 'utf8')) as StateStore;
  } catch {
    return {};
  }
}

function persist(store: StateStore): void {
  try {
    writeFileSync(STORE_PATH, JSON.stringify(store), 'utf8');
  } catch (err) {
    // Non-fatal: fall back to in-memory only for this request cycle
    console.error('[OAuthStateStore] Failed to persist state store:', err);
  }
}

function pruneExpired(store: StateStore): StateStore {
  const now = Date.now();
  const pruned: StateStore = {};
  for (const [state, ts] of Object.entries(store)) {
    if (now - ts <= STATE_TTL_MS) {
      pruned[state] = ts;
    }
  }
  return pruned;
}

export function storeState(state: string): void {
  const store = pruneExpired(load());
  store[state] = Date.now();
  persist(store);
}

export function consumeState(state: string): boolean {
  const store = pruneExpired(load());
  const ts = store[state];
  if (!ts) return false;

  delete store[state];
  persist(store);

  return Date.now() - ts <= STATE_TTL_MS;
}
