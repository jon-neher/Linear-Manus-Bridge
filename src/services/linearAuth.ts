const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5-minute buffer before expiry

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

/**
 * Persist a token record for a workspace.
 */
export function saveTokenRecord(workspaceId: string, record: TokenRecord): void {
  tokenStore.set(workspaceId, { ...record });
}

/**
 * Retrieve the stored token record for a workspace.
 */
export function getTokenRecord(workspaceId: string): TokenRecord | undefined {
  return tokenStore.get(workspaceId);
}

/**
 * Exchange a refresh token for a new token pair from Linear.
 */
async function refreshAccessToken(refreshToken: string): Promise<LinearTokenResponse> {
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
    throw new Error(`Token refresh failed (${response.status}): ${text}`);
  }

  return response.json() as Promise<LinearTokenResponse>;
}

/**
 * Return a valid access token for the given workspace, refreshing it if needed.
 */
export async function getValidToken(workspaceId: string): Promise<string> {
  const record = getTokenRecord(workspaceId);
  if (!record) {
    throw new Error(`No token record found for workspace: ${workspaceId}`);
  }

  const isExpiringSoon = Date.now() >= record.expiresAt - TOKEN_REFRESH_BUFFER_MS;
  if (!isExpiringSoon) {
    return record.accessToken;
  }

  const tokenData = await refreshAccessToken(record.refreshToken);

  const newRecord: TokenRecord = {
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    expiresAt: Date.now() + tokenData.expires_in * 1000,
    installationId: record.installationId,
  };

  // Persist atomically before returning to prevent use of invalidated tokens
  saveTokenRecord(workspaceId, newRecord);

  return newRecord.accessToken;
}
