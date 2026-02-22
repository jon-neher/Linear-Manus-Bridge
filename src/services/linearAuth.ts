const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5-minute buffer before expiry
const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';

export class ReAuthorizationRequiredError extends Error {
  constructor(public readonly workspaceId: string, message?: string) {
    super(message ?? `Re-authorization required for workspace: ${workspaceId}`);
    this.name = 'ReAuthorizationRequiredError';
  }
}

export interface TokenRecord {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  installationId: string;
}

interface LinearTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

// In-memory token store keyed by workspaceId.
// Replace with a persistent database or secrets store in production.
const tokenStore = new Map<string, TokenRecord>();

// Track workspaces that need re-authorization after refresh token expiry.
const reAuthRequired = new Set<string>();

/**
 * Persist a token record for a workspace.
 */
export function saveTokenRecord(workspaceId: string, record: TokenRecord): void {
  tokenStore.set(workspaceId, { ...record });
  reAuthRequired.delete(workspaceId);
}

/**
 * Retrieve the stored token record for a workspace.
 */
export function getTokenRecord(workspaceId: string): TokenRecord | undefined {
  return tokenStore.get(workspaceId);
}

/**
 * Remove a workspace's token record (e.g. when refresh token is invalid).
 */
export function clearTokenRecord(workspaceId: string): void {
  tokenStore.delete(workspaceId);
  reAuthRequired.add(workspaceId);
}

/**
 * Check if a workspace needs re-authorization.
 */
export function needsReAuthorization(workspaceId: string): boolean {
  return reAuthRequired.has(workspaceId);
}

/**
 * Exchange a refresh token for a new token pair from Linear.
 * Throws ReAuthorizationRequiredError when the refresh token is invalid/expired.
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

  const response = await fetch('https://api.linear.app/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!response.ok) {
    const text = await response.text();

    // 400/401 from the token endpoint means the refresh token is invalid/expired
    if (response.status === 400 || response.status === 401) {
      clearTokenRecord(workspaceId);
      throw new ReAuthorizationRequiredError(
        workspaceId,
        `Refresh token expired or revoked for workspace ${workspaceId}: ${text}`,
      );
    }

    throw new Error(`Token refresh failed (${response.status}): ${text}`);
  }

  return response.json() as Promise<LinearTokenResponse>;
}

// Guard against concurrent refresh attempts for the same workspace.
const inflightRefreshes = new Map<string, Promise<string>>();

/**
 * Return a valid access token for the given workspace, refreshing it if needed.
 * Throws ReAuthorizationRequiredError when re-authorization is necessary.
 */
export async function getValidToken(workspaceId: string): Promise<string> {
  if (reAuthRequired.has(workspaceId)) {
    throw new ReAuthorizationRequiredError(workspaceId);
  }

  const record = getTokenRecord(workspaceId);
  if (!record) {
    throw new ReAuthorizationRequiredError(workspaceId, `No token record found for workspace: ${workspaceId}`);
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

      const newRecord: TokenRecord = {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token,
        expiresAt: Date.now() + tokenData.expires_in * 1000,
        installationId: record.installationId,
      };

      // Persist atomically before returning to prevent use of invalidated tokens
      saveTokenRecord(workspaceId, newRecord);

      return newRecord.accessToken;
    } finally {
      inflightRefreshes.delete(workspaceId);
    }
  })();

  inflightRefreshes.set(workspaceId, refreshPromise);
  return refreshPromise;
}

/**
 * Make an authenticated request to the Linear GraphQL API.
 * Automatically retries once on 401 by refreshing the token.
 */
export async function linearApiRequest<T = unknown>(
  workspaceId: string,
  body: { query: string; variables?: Record<string, unknown> },
): Promise<T> {
  let accessToken = await getValidToken(workspaceId);

  let response = await fetch(LINEAR_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  });

  // On 401, force a token refresh and retry once
  if (response.status === 401) {
    const record = getTokenRecord(workspaceId);
    if (!record) {
      throw new ReAuthorizationRequiredError(workspaceId);
    }

    // Force refresh by temporarily setting expiresAt to 0
    saveTokenRecord(workspaceId, { ...record, expiresAt: 0 });
    accessToken = await getValidToken(workspaceId);

    response = await fetch(LINEAR_GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
    });

    if (response.status === 401) {
      clearTokenRecord(workspaceId);
      throw new ReAuthorizationRequiredError(
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
}
