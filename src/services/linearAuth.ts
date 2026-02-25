import {
  getInstallationByWorkspace,
  getInstallationByAppId,
  updateInstallationTokens,
  markInstallationInactive,
  type InstallationRecord,
} from './installationStore';
import { LINEAR_GRAPHQL_URL, TOKEN_REFRESH_BUFFER_MS } from './constants';
import { fetchWithTimeout } from './fetchWithTimeout';
import { isTimeoutError, handleTimeoutError } from './timeoutErrorHandler';

export class TokenRevokedError extends Error {
  constructor(public readonly workspaceId: string, message?: string) {
    super(message ?? `Token revoked for workspace: ${workspaceId}`);
    this.name = 'TokenRevokedError';
  }
}

interface LinearTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

/**
 * Exchange a refresh token for a new token pair from Linear.
 * Throws TokenRevokedError when the refresh token is invalid/expired.
 */
async function refreshAccessToken(
  workspaceId: string,
  refreshToken: string,
): Promise<LinearTokenResponse> {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: process.env.LINEAR_CLIENT_ID!,
    client_secret: process.env.LINEAR_CLIENT_SECRET!,
    refresh_token: refreshToken,
  });

  try {
    const response = await fetchWithTimeout('https://api.linear.app/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!response.ok) {
      const text = await response.text();

      // 400/401 from the token endpoint means the refresh token is invalid/expired
      if (response.status === 400 || response.status === 401) {
        markInstallationInactive(workspaceId);
        throw new TokenRevokedError(
          workspaceId,
          `Refresh token expired or revoked for workspace ${workspaceId}: ${text}`,
        );
      }

      throw new Error(`Token refresh failed (${response.status}): ${text}`);
    }

    return response.json() as Promise<LinearTokenResponse>;
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new Error(handleTimeoutError('refreshAccessToken', error));
    }
    throw error;
  }
}

// Guard against concurrent refresh attempts for the same workspace.
const inflightRefreshes = new Map<string, Promise<string>>();

/**
 * Return a valid access token for the given workspace, refreshing if needed.
 * Throws TokenRevokedError if the token has been revoked (401).
 */
export async function getValidToken(workspaceId: string): Promise<string> {
  const record = getInstallationByWorkspace(workspaceId);
  if (!record) {
    throw new TokenRevokedError(workspaceId, `No installation record found for workspace: ${workspaceId}`);
  }

  if (!record.active) {
    throw new TokenRevokedError(workspaceId);
  }

  const isExpiringSoon = Date.now() >= record.expiresAt - TOKEN_REFRESH_BUFFER_MS;
  if (!isExpiringSoon) {
    return record.accessToken;
  }

  // Deduplicate concurrent refresh requests for the same workspace
  const inflight = inflightRefreshes.get(workspaceId);
  if (inflight) {
    return inflight;
  }

  const refreshPromise = (async () => {
    try {
      const tokenData = await refreshAccessToken(workspaceId, record.refreshToken);

      updateInstallationTokens(
        workspaceId,
        tokenData.access_token,
        tokenData.refresh_token,
        Date.now() + tokenData.expires_in * 1000,
      );

      return tokenData.access_token;
    } catch (err) {
      if (err instanceof TokenRevokedError) {
        markInstallationInactive(workspaceId);
      }
      throw err;
    } finally {
      inflightRefreshes.delete(workspaceId);
    }
  })();

  inflightRefreshes.set(workspaceId, refreshPromise);
  return refreshPromise;
}

/**
 * Handle a 401 response from the Linear API by marking the installation inactive.
 * Call this when any Linear API request returns 401.
 */
export function handleApiRevocation(workspaceId: string): void {
  markInstallationInactive(workspaceId);
  console.warn(`Installation for workspace ${workspaceId} marked inactive due to token revocation`);
}

/**
 * Look up an installation by app installation ID (used for webhook routing).
 */
export function resolveWorkspaceFromInstallation(appInstallationId: string): InstallationRecord | undefined {
  return getInstallationByAppId(appInstallationId);
}

/**
 * Make an authenticated request to the Linear GraphQL API.
 * Automatically retries once on 401 by refreshing the token.
 */
export async function linearApiRequest<T = unknown>(
  workspaceId: string,
  body: { query: string; variables?: Record<string, unknown> },
): Promise<T> {
  try {
    let accessToken = await getValidToken(workspaceId);

    let response = await fetchWithTimeout(LINEAR_GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
    });

    // On 401, force a token refresh and retry once
    if (response.status === 401) {
      const record = getInstallationByWorkspace(workspaceId);
      if (!record) {
        throw new TokenRevokedError(workspaceId);
      }

      // Force refresh by updating record with 0 expiry (it's in-memory currently, but updateInstallationTokens persists it)
      updateInstallationTokens(workspaceId, record.accessToken, record.refreshToken, 0);
      accessToken = await getValidToken(workspaceId);

      response = await fetchWithTimeout(LINEAR_GRAPHQL_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify(body),
      });

      if (response.status === 401) {
        markInstallationInactive(workspaceId);
        throw new TokenRevokedError(
          workspaceId,
          `Persistent 401 after token refresh for workspace ${workspaceId}`,
        );
      }
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Linear API request failed (${response.status}): ${text}`);
    }

    return response.json() as Promise<T>;
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new Error(handleTimeoutError('linearApiRequest', error));
    }
    throw error;
  }
}
