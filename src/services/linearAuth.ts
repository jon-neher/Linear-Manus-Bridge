import {
  getInstallationByWorkspace,
  getInstallationByAppId,
  updateInstallationTokens,
  markInstallationInactive,
  type InstallationRecord,
} from './installationStore';

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5-minute buffer before expiry

interface LinearTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

export class TokenRevokedError extends Error {
  constructor(public workspaceId: string) {
    super(`Token revoked for workspace: ${workspaceId}`);
    this.name = 'TokenRevokedError';
  }
}

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

  if (response.status === 401) {
    throw new TokenRevokedError('unknown');
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token refresh failed (${response.status}): ${text}`);
  }

  return response.json() as Promise<LinearTokenResponse>;
}

/**
 * Return a valid access token for the given workspace, refreshing if needed.
 * Throws TokenRevokedError if the token has been revoked (401).
 */
export async function getValidToken(workspaceId: string): Promise<string> {
  const record = getInstallationByWorkspace(workspaceId);
  if (!record) {
    throw new Error(`No installation record found for workspace: ${workspaceId}`);
  }

  if (!record.active) {
    throw new TokenRevokedError(workspaceId);
  }

  const isExpiringSoon = Date.now() >= record.expiresAt - TOKEN_REFRESH_BUFFER_MS;
  if (!isExpiringSoon) {
    return record.accessToken;
  }

  try {
    const tokenData = await refreshAccessToken(record.refreshToken);

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
      throw new TokenRevokedError(workspaceId);
    }
    throw err;
  }
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
