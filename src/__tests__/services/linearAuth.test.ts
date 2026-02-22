import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { InstallationRecord } from '../../services/installationStore';

vi.mock('../../services/installationStore', () => ({
  getInstallationByWorkspace: vi.fn(),
  getInstallationByAppId: vi.fn(),
  updateInstallationTokens: vi.fn(),
  markInstallationInactive: vi.fn(),
}));

import {
  getInstallationByWorkspace,
  getInstallationByAppId,
  updateInstallationTokens,
  markInstallationInactive,
} from '../../services/installationStore';

import {
  TokenRevokedError,
  getValidToken,
  handleApiRevocation,
  resolveWorkspaceFromInstallation,
  linearApiRequest,
} from '../../services/linearAuth';

const WORKSPACE_ID = 'ws-1';
const GRAPHQL_URL = 'https://api.linear.app/graphql';
const OAUTH_TOKEN_URL = 'https://api.linear.app/oauth/token';

function makeRecord(overrides: Partial<InstallationRecord> = {}): InstallationRecord {
  return {
    workspaceId: WORKSPACE_ID,
    workspaceName: 'Test Workspace',
    appInstallationId: 'app-install-1',
    accessToken: 'current-access-token',
    refreshToken: 'current-refresh-token',
    expiresAt: Date.now() + 60 * 60 * 1000, // 1 hour from now
    active: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function mockFetchResponse(ok: boolean, status: number, body: unknown) {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  } as Response;
}

describe('linearAuth', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.mocked(getInstallationByWorkspace).mockReset();
    vi.mocked(getInstallationByAppId).mockReset();
    vi.mocked(updateInstallationTokens).mockReset();
    vi.mocked(markInstallationInactive).mockReset();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('TokenRevokedError', () => {
    it('has correct name, message, and workspaceId', () => {
      const error = new TokenRevokedError('ws-42', 'custom message');
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('TokenRevokedError');
      expect(error.message).toBe('custom message');
      expect(error.workspaceId).toBe('ws-42');
    });

    it('uses default message when none provided', () => {
      const error = new TokenRevokedError('ws-42');
      expect(error.message).toBe('Token revoked for workspace: ws-42');
    });
  });

  describe('getValidToken', () => {
    it('returns existing token when not expiring', async () => {
      const record = makeRecord();
      vi.mocked(getInstallationByWorkspace).mockReturnValue(record);

      const token = await getValidToken(WORKSPACE_ID);
      expect(token).toBe('current-access-token');
      expect(globalThis.fetch).toBeUndefined; // no fetch call needed
    });

    it('refreshes token when expiring within 5 min buffer', async () => {
      const record = makeRecord({
        expiresAt: Date.now() + 2 * 60 * 1000, // 2 minutes from now (within 5 min buffer)
      });
      vi.mocked(getInstallationByWorkspace).mockReturnValue(record);

      globalThis.fetch = vi.fn().mockResolvedValue(
        mockFetchResponse(true, 200, {
          access_token: 'new-access-token',
          refresh_token: 'new-refresh-token',
          expires_in: 3600,
        }),
      );

      const token = await getValidToken(WORKSPACE_ID);
      expect(token).toBe('new-access-token');
      expect(globalThis.fetch).toHaveBeenCalledWith(
        OAUTH_TOKEN_URL,
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        }),
      );
      expect(updateInstallationTokens).toHaveBeenCalledWith(
        WORKSPACE_ID,
        'new-access-token',
        'new-refresh-token',
        expect.any(Number),
      );
    });

    it('throws TokenRevokedError when no installation record', async () => {
      vi.mocked(getInstallationByWorkspace).mockReturnValue(undefined);

      await expect(getValidToken(WORKSPACE_ID)).rejects.toThrow(TokenRevokedError);
    });

    it('throws TokenRevokedError when installation is inactive', async () => {
      vi.mocked(getInstallationByWorkspace).mockReturnValue(
        makeRecord({ active: false }),
      );

      await expect(getValidToken(WORKSPACE_ID)).rejects.toThrow(TokenRevokedError);
    });

    it('throws TokenRevokedError when refresh returns 400', async () => {
      const record = makeRecord({ expiresAt: Date.now() }); // expired
      vi.mocked(getInstallationByWorkspace).mockReturnValue(record);

      globalThis.fetch = vi.fn().mockResolvedValue(
        mockFetchResponse(false, 400, 'Bad Request'),
      );

      await expect(getValidToken(WORKSPACE_ID)).rejects.toThrow(TokenRevokedError);
      expect(markInstallationInactive).toHaveBeenCalledWith(WORKSPACE_ID);
    });

    it('throws TokenRevokedError when refresh returns 401', async () => {
      const record = makeRecord({ expiresAt: Date.now() }); // expired
      vi.mocked(getInstallationByWorkspace).mockReturnValue(record);

      globalThis.fetch = vi.fn().mockResolvedValue(
        mockFetchResponse(false, 401, 'Unauthorized'),
      );

      await expect(getValidToken(WORKSPACE_ID)).rejects.toThrow(TokenRevokedError);
      expect(markInstallationInactive).toHaveBeenCalledWith(WORKSPACE_ID);
    });

    it('deduplicates concurrent refresh calls', async () => {
      const record = makeRecord({ expiresAt: Date.now() }); // expired
      vi.mocked(getInstallationByWorkspace).mockReturnValue(record);

      globalThis.fetch = vi.fn().mockResolvedValue(
        mockFetchResponse(true, 200, {
          access_token: 'deduped-token',
          refresh_token: 'new-refresh',
          expires_in: 3600,
        }),
      );

      const [token1, token2] = await Promise.all([
        getValidToken(WORKSPACE_ID),
        getValidToken(WORKSPACE_ID),
      ]);

      expect(token1).toBe('deduped-token');
      expect(token2).toBe('deduped-token');
      // fetch should only be called once despite two concurrent calls
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('handleApiRevocation', () => {
    it('marks installation inactive', () => {
      handleApiRevocation(WORKSPACE_ID);
      expect(markInstallationInactive).toHaveBeenCalledWith(WORKSPACE_ID);
    });
  });

  describe('resolveWorkspaceFromInstallation', () => {
    it('returns installation record by app id', () => {
      const record = makeRecord();
      vi.mocked(getInstallationByAppId).mockReturnValue(record);

      const result = resolveWorkspaceFromInstallation('app-install-1');
      expect(result).toBe(record);
      expect(getInstallationByAppId).toHaveBeenCalledWith('app-install-1');
    });

    it('returns undefined when not found', () => {
      vi.mocked(getInstallationByAppId).mockReturnValue(undefined);

      const result = resolveWorkspaceFromInstallation('unknown');
      expect(result).toBeUndefined();
    });
  });

  describe('linearApiRequest', () => {
    it('makes authenticated request and returns data', async () => {
      const record = makeRecord();
      vi.mocked(getInstallationByWorkspace).mockReturnValue(record);

      const responseData = { viewer: { id: 'user-1' } };
      globalThis.fetch = vi.fn().mockResolvedValue(
        mockFetchResponse(true, 200, { data: responseData }),
      );

      const result = await linearApiRequest(WORKSPACE_ID, {
        query: '{ viewer { id } }',
      });
      expect(result).toEqual({ data: responseData });
      expect(globalThis.fetch).toHaveBeenCalledWith(
        GRAPHQL_URL,
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: `Bearer current-access-token`,
          }),
        }),
      );
    });

    it('retries on 401 with refreshed token', async () => {
      const record = makeRecord();
      vi.mocked(getInstallationByWorkspace).mockReturnValue(record);

      const responseData = { viewer: { id: 'user-1' } };

      // First call: 401, second call: refresh token, third call: success
      globalThis.fetch = vi
        .fn()
        // First API call returns 401
        .mockResolvedValueOnce(mockFetchResponse(false, 401, 'Unauthorized'))
        // Token refresh call succeeds
        .mockResolvedValueOnce(
          mockFetchResponse(true, 200, {
            access_token: 'refreshed-token',
            refresh_token: 'new-refresh',
            expires_in: 3600,
          }),
        )
        // Retry API call succeeds
        .mockResolvedValueOnce(
          mockFetchResponse(true, 200, { data: responseData }),
        );

      // Force expiry so getValidToken triggers a refresh on the retry path
      vi.mocked(updateInstallationTokens).mockImplementation(
        (wsId, at, rt, exp) => {
          // After updateInstallationTokens is called with expiry 0,
          // getInstallationByWorkspace should return an expired record
          vi.mocked(getInstallationByWorkspace).mockReturnValue(
            makeRecord({ accessToken: at, refreshToken: rt, expiresAt: exp }),
          );
        },
      );

      const result = await linearApiRequest(WORKSPACE_ID, {
        query: '{ viewer { id } }',
      });
      expect(result).toEqual({ data: responseData });
      // Should have made 3 fetch calls: original, refresh, retry
      expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    });

    it('throws TokenRevokedError on persistent 401', async () => {
      const record = makeRecord();
      vi.mocked(getInstallationByWorkspace).mockReturnValue(record);

      // First call: 401, refresh succeeds, retry: still 401
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce(mockFetchResponse(false, 401, 'Unauthorized'))
        .mockResolvedValueOnce(
          mockFetchResponse(true, 200, {
            access_token: 'refreshed-token',
            refresh_token: 'new-refresh',
            expires_in: 3600,
          }),
        )
        .mockResolvedValueOnce(mockFetchResponse(false, 401, 'Still unauthorized'));

      vi.mocked(updateInstallationTokens).mockImplementation(
        (wsId, at, rt, exp) => {
          vi.mocked(getInstallationByWorkspace).mockReturnValue(
            makeRecord({ accessToken: at, refreshToken: rt, expiresAt: exp }),
          );
        },
      );

      await expect(
        linearApiRequest(WORKSPACE_ID, { query: '{ viewer { id } }' }),
      ).rejects.toThrow(TokenRevokedError);
      expect(markInstallationInactive).toHaveBeenCalledWith(WORKSPACE_ID);
    });
  });
});
