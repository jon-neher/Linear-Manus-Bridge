import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('oauthStateStore', () => {
  let tempDir: string;
  let storeState: typeof import('../../services/oauthStateStore').storeState;
  let consumeState: typeof import('../../services/oauthStateStore').consumeState;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'oauth-state-test-'));
    process.env.DATA_DIR = tempDir;
    vi.resetModules();
    const mod = await import('../../services/oauthStateStore');
    storeState = mod.storeState;
    consumeState = mod.consumeState;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('stores and consumes a state token successfully', () => {
    storeState('abc123');
    expect(consumeState('abc123')).toBe(true);
  });

  it('returns false for an unknown token', () => {
    expect(consumeState('unknown')).toBe(false);
  });

  it('returns false and removes an expired token', () => {
    const realNow = Date.now();
    const dateSpy = vi.spyOn(Date, 'now');

    // Store at "now"
    dateSpy.mockReturnValue(realNow);
    storeState('expiring');

    // Advance past TTL (10 minutes + 1 ms)
    dateSpy.mockReturnValue(realNow + 10 * 60 * 1000 + 1);
    expect(consumeState('expiring')).toBe(false);
  });

  it('consumed token cannot be consumed again', () => {
    storeState('once');
    expect(consumeState('once')).toBe(true);
    expect(consumeState('once')).toBe(false);
  });

  it('persists state to file and survives re-import', async () => {
    storeState('persist-me');

    const filePath = join(tempDir, '.oauth-states.json');
    expect(existsSync(filePath)).toBe(true);

    const raw = JSON.parse(readFileSync(filePath, 'utf8'));
    expect(raw).toHaveProperty('persist-me');

    // Re-import to simulate fresh module load
    vi.resetModules();
    const freshMod = await import('../../services/oauthStateStore');
    expect(freshMod.consumeState('persist-me')).toBe(true);
  });
});
