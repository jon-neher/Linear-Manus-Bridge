'use strict';

const { randomBytes } = require('crypto');
const { Router } = require('express');
const { saveTokenRecord } = require('../services/linearAuth');

const router = Router();

const LINEAR_AUTHORIZE_URL = 'https://linear.app/oauth/authorize';
const LINEAR_TOKEN_URL = 'https://api.linear.app/oauth/token';
const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';

const OAUTH_SCOPES = 'read,write,app:assignable,app:mentionable';

// Short-lived in-memory state store for CSRF protection.
// Replace with a distributed cache (e.g. Redis) in a multi-instance deployment.
const pendingStates = new Map();
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function generateState() {
  return randomBytes(32).toString('hex');
}

function storeState(state) {
  pendingStates.set(state, Date.now());

  // Clean up expired states
  for (const [s, ts] of pendingStates) {
    if (Date.now() - ts > STATE_TTL_MS) {
      pendingStates.delete(s);
    }
  }
}

function consumeState(state) {
  const ts = pendingStates.get(state);
  if (!ts) return false;
  pendingStates.delete(state);
  return Date.now() - ts <= STATE_TTL_MS;
}

/**
 * GET /oauth/install
 * Redirects the workspace admin to the Linear authorization screen.
 */
router.get('/install', (req, res) => {
  const state = generateState();
  storeState(state);

  const params = new URLSearchParams({
    client_id: process.env.LINEAR_CLIENT_ID,
    redirect_uri: process.env.LINEAR_REDIRECT_URI,
    response_type: 'code',
    scope: OAUTH_SCOPES,
    actor: 'app',
    state,
  });

  res.redirect(`${LINEAR_AUTHORIZE_URL}?${params.toString()}`);
});

/**
 * GET /oauth/callback
 * Handles the redirect from Linear after the admin approves the installation.
 */
router.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.status(400).json({ error: `Linear authorization error: ${error}` });
  }

  if (!state || !consumeState(state)) {
    return res.status(400).json({ error: 'Invalid or expired state parameter' });
  }

  if (!code) {
    return res.status(400).json({ error: 'Missing authorization code' });
  }

  let tokenData;
  try {
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: process.env.LINEAR_CLIENT_ID,
      client_secret: process.env.LINEAR_CLIENT_SECRET,
      redirect_uri: process.env.LINEAR_REDIRECT_URI,
      code,
    });

    const tokenResponse = await fetch(LINEAR_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    if (!tokenResponse.ok) {
      const text = await tokenResponse.text();
      throw new Error(`Token exchange failed (${tokenResponse.status}): ${text}`);
    }

    tokenData = await tokenResponse.json();
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }

  let installationId;
  try {
    const viewerResponse = await fetch(LINEAR_GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenData.access_token}`,
      },
      body: JSON.stringify({ query: '{ viewer { id } }' }),
    });

    if (!viewerResponse.ok) {
      const text = await viewerResponse.text();
      throw new Error(`Viewer query failed (${viewerResponse.status}): ${text}`);
    }

    const viewerData = await viewerResponse.json();
    installationId = viewerData?.data?.viewer?.id;

    if (!installationId) {
      throw new Error('Could not retrieve installation ID from viewer query');
    }
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }

  saveTokenRecord(installationId, {
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    expiresAt: Date.now() + (tokenData.expires_in ?? 3600) * 1000,
    installationId,
  });

  res.json({ ok: true, installationId });
});

module.exports = router;
