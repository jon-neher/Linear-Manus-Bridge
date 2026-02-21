'use strict';

const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5-minute buffer before expiry

// In-memory token store keyed by workspaceId.
// Replace with a persistent database or secrets store in production.
const tokenStore = new Map();

/**
 * Persist a token record for a workspace.
 * @param {string} workspaceId
 * @param {{ accessToken: string, refreshToken: string, expiresAt: number, installationId: string }} record
 */
function saveTokenRecord(workspaceId, record) {
  tokenStore.set(workspaceId, { ...record });
}

/**
 * Retrieve the stored token record for a workspace.
 * @param {string} workspaceId
 * @returns {{ accessToken: string, refreshToken: string, expiresAt: number, installationId: string } | undefined}
 */
function getTokenRecord(workspaceId) {
  return tokenStore.get(workspaceId);
}

/**
 * Exchange a refresh token for a new token pair from Linear.
 * @param {string} refreshToken
 * @returns {Promise<{ access_token: string, refresh_token: string, expires_in: number }>}
 */
async function refreshAccessToken(refreshToken) {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: process.env.LINEAR_CLIENT_ID,
    client_secret: process.env.LINEAR_CLIENT_SECRET,
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

  return response.json();
}

/**
 * Return a valid access token for the given workspace, refreshing it if needed.
 * @param {string} workspaceId
 * @returns {Promise<string>} A valid access token
 */
async function getValidToken(workspaceId) {
  const record = getTokenRecord(workspaceId);
  if (!record) {
    throw new Error(`No token record found for workspace: ${workspaceId}`);
  }

  const isExpiringSoon = Date.now() >= record.expiresAt - TOKEN_REFRESH_BUFFER_MS;
  if (!isExpiringSoon) {
    return record.accessToken;
  }

  const tokenData = await refreshAccessToken(record.refreshToken);

  const newRecord = {
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    expiresAt: Date.now() + tokenData.expires_in * 1000,
    installationId: record.installationId,
  };

  // Persist atomically before returning to prevent use of invalidated tokens
  saveTokenRecord(workspaceId, newRecord);

  return newRecord.accessToken;
}

module.exports = { getValidToken, saveTokenRecord, getTokenRecord };
