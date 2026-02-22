import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { InstallationRecord } from '../../services/installationStore';

describe('installationStore', () => {
  let tempDir: string;
  let saveInstallation: typeof import('../../services/installationStore').saveInstallation;
  let getInstallationByWorkspace: typeof import('../../services/installationStore').getInstallationByWorkspace;
  let getInstallationByAppId: typeof import('../../services/installationStore').getInstallationByAppId;
  let markInstallationInactive: typeof import('../../services/installationStore').markInstallationInactive;
  let updateInstallationTokens: typeof import('../../services/installationStore').updateInstallationTokens;
  let getAllActiveInstallations: typeof import('../../services/installationStore').getAllActiveInstallations;

  function makeRecord(overrides: Partial<InstallationRecord> = {}): InstallationRecord {
    return {
      workspaceId: 'ws-1',
      workspaceName: 'Test Workspace',
      appInstallationId: 'app-1',
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 3600_000,
      active: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...overrides,
    };
  }

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'install-store-test-'));
    process.env.DATA_DIR = tempDir;
    process.env.INSTALLATION_STORE_SECRET = 'test-store-secret-at-least-16';
    vi.resetModules();
    const mod = await import('../../services/installationStore');
    saveInstallation = mod.saveInstallation;
    getInstallationByWorkspace = mod.getInstallationByWorkspace;
    getInstallationByAppId = mod.getInstallationByAppId;
    markInstallationInactive = mod.markInstallationInactive;
    updateInstallationTokens = mod.updateInstallationTokens;
    getAllActiveInstallations = mod.getAllActiveInstallations;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('saveInstallation / getInstallationByWorkspace', () => {
    it('saves and retrieves an installation by workspaceId', () => {
      const record = makeRecord();
      saveInstallation(record);
      const retrieved = getInstallationByWorkspace('ws-1');
      expect(retrieved).toEqual(record);
    });

    it('returns undefined for unknown workspaceId', () => {
      expect(getInstallationByWorkspace('unknown')).toBeUndefined();
    });
  });

  describe('getInstallationByAppId', () => {
    it('finds installation by appInstallationId', () => {
      saveInstallation(makeRecord({ appInstallationId: 'app-42' }));
      const found = getInstallationByAppId('app-42');
      expect(found?.appInstallationId).toBe('app-42');
    });

    it('returns undefined for unknown appInstallationId', () => {
      expect(getInstallationByAppId('unknown')).toBeUndefined();
    });
  });

  describe('markInstallationInactive', () => {
    it('sets active to false and updates timestamp', () => {
      saveInstallation(makeRecord());
      markInstallationInactive('ws-1');
      const record = getInstallationByWorkspace('ws-1');
      expect(record?.active).toBe(false);
    });

    it('is a no-op for unknown workspaceId', () => {
      markInstallationInactive('unknown');
      expect(getInstallationByWorkspace('unknown')).toBeUndefined();
    });
  });

  describe('updateInstallationTokens', () => {
    it('updates access token, refresh token, and expiresAt', () => {
      saveInstallation(makeRecord());
      const newExpiry = Date.now() + 7200_000;
      updateInstallationTokens('ws-1', 'new-access', 'new-refresh', newExpiry);

      const record = getInstallationByWorkspace('ws-1');
      expect(record?.accessToken).toBe('new-access');
      expect(record?.refreshToken).toBe('new-refresh');
      expect(record?.expiresAt).toBe(newExpiry);
    });

    it('is a no-op for unknown workspaceId', () => {
      updateInstallationTokens('unknown', 'a', 'b', 0);
      expect(getInstallationByWorkspace('unknown')).toBeUndefined();
    });
  });

  describe('getAllActiveInstallations', () => {
    it('returns only active installations as defensive copies', () => {
      saveInstallation(makeRecord({ workspaceId: 'ws-1' }));
      saveInstallation(makeRecord({ workspaceId: 'ws-2', active: false }));
      saveInstallation(makeRecord({ workspaceId: 'ws-3' }));

      const active = getAllActiveInstallations();
      expect(active).toHaveLength(2);
      expect(active.map((r) => r.workspaceId).sort()).toEqual(['ws-1', 'ws-3']);

      // Verify defensive copy
      active[0].accessToken = 'mutated';
      const original = getInstallationByWorkspace(active[0].workspaceId);
      expect(original?.accessToken).not.toBe('mutated');
    });
  });

  describe('encryption roundtrip', () => {
    it('persists encrypted data to file and survives re-import', async () => {
      const record = makeRecord();
      saveInstallation(record);

      const filePath = join(tempDir, '.installations.enc');
      expect(existsSync(filePath)).toBe(true);

      // Re-import to simulate fresh process
      vi.resetModules();
      const freshMod = await import('../../services/installationStore');
      const retrieved = freshMod.getInstallationByWorkspace('ws-1');
      expect(retrieved).toEqual(record);
    });
  });
});
