import { randomBytes } from 'crypto';
import { Router, Request, Response } from 'express';
import { saveInstallation, getInstallationByWorkspace, getAllActiveInstallations } from '../services/installationStore';
import { storeState, consumeState } from '../services/oauthStateStore';
import {
  LINEAR_AUTHORIZE_URL,
  LINEAR_TOKEN_URL,
  LINEAR_GRAPHQL_URL,
  OAUTH_SCOPES,
} from '../services/constants';

const router = Router();

interface LinearTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
}

interface LinearGraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

interface LinearViewerData {
  viewer: {
    id: string;
  };
}

interface LinearOrganizationData {
  organization: {
    id: string;
    name: string;
  };
}

function generateState(): string {
  return randomBytes(32).toString('hex');
}

/**
 * GET /oauth/install
 * Redirects the workspace admin to the Linear authorization screen.
 */
router.get('/install', (_req: Request, res: Response): void => {
  const state = generateState();
  storeState(state);

  const params = new URLSearchParams({
    client_id: process.env.LINEAR_CLIENT_ID!,
    redirect_uri: process.env.LINEAR_REDIRECT_URI!,
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
router.get('/callback', async (req: Request, res: Response): Promise<void> => {
  const { code, state, error } = req.query as { code?: string; state?: string; error?: string };

  if (error) {
    res.status(400).json({ error: `Linear authorization error: ${error}` });
    return;
  }

  if (!state || !consumeState(state)) {
    res.status(400).json({ error: 'Invalid or expired state parameter' });
    return;
  }

  if (!code) {
    res.status(400).json({ error: 'Missing authorization code' });
    return;
  }

  let tokenData: LinearTokenResponse;
  try {
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: process.env.LINEAR_CLIENT_ID!,
      client_secret: process.env.LINEAR_CLIENT_SECRET!,
      redirect_uri: process.env.LINEAR_REDIRECT_URI!,
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

    tokenData = await tokenResponse.json() as LinearTokenResponse;
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
    return;
  }

  let installationId: string;
  let workspaceId: string;
  let workspaceName: string;
  try {
    const query = `{
      viewer { id }
      organization { id name }
    }`;

    const gqlResponse = await fetch(LINEAR_GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenData.access_token}`,
      },
      body: JSON.stringify({ query }),
    });

    if (!gqlResponse.ok) {
      const text = await gqlResponse.text();
      throw new Error(`GraphQL query failed (${gqlResponse.status}): ${text}`);
    }

    const gqlData = await gqlResponse.json() as LinearGraphQLResponse<LinearViewerData & LinearOrganizationData>;

    installationId = gqlData?.data?.viewer?.id ?? '';
    workspaceId = gqlData?.data?.organization?.id ?? '';
    workspaceName = gqlData?.data?.organization?.name ?? '';

    if (!installationId) {
      throw new Error('Could not retrieve installation ID from viewer query');
    }
    if (!workspaceId) {
      throw new Error('Could not retrieve workspace ID from organization query');
    }
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
    return;
  }

  const now = Date.now();
  saveInstallation({
    workspaceId,
    workspaceName,
    appInstallationId: installationId,
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    expiresAt: now + (tokenData.expires_in ?? 3600) * 1000,
    active: true,
    createdAt: now,
    updatedAt: now,
  });

  res.json({ ok: true, installationId, workspaceId });
});

/**
 * GET /oauth/installations
 * Lists all stored workspace installations.
 * Used to verify that the OAuth flow completed successfully.
 */
router.get('/installations', (_req: Request, res: Response): void => {
  const all = getAllActiveInstallations();
  const result = all.map((rec) => ({
    workspaceId: rec.workspaceId,
    workspaceName: rec.workspaceName,
    active: rec.active,
    expiresInSeconds: Math.max(0, Math.floor((rec.expiresAt - Date.now()) / 1000)),
  }));
  res.json({ count: result.length, installations: result });
});

/**
 * GET /oauth/status/:workspaceId
 * Returns the token status for a workspace, including whether re-authorization is needed.
 */
router.get('/status/:workspaceId', (req: Request, res: Response): void => {
  const { workspaceId } = req.params;

  const record = getInstallationByWorkspace(workspaceId);
  if (!record) {
    res.status(404).json({ status: 'not_found' });
    return;
  }

  if (!record.active) {
    res.status(401).json({
      status: 'reauthorization_required',
      installUrl: `/oauth/install`,
    });
    return;
  }

  const expiresIn = Math.max(0, Math.floor((record.expiresAt - Date.now()) / 1000));
  res.json({
    status: 'active',
    expiresInSeconds: expiresIn,
  });
});

export default router;
