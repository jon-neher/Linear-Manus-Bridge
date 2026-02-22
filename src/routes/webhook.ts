import { createHmac, timingSafeEqual } from 'crypto';
import { Router, Request, Response } from 'express';
import { consumeTask } from '../services/taskStore';
import { getValidToken } from '../services/linearAuth';
import {
  postComment,
  findStateIdByName,
  updateIssueState,
} from '../services/linearClient';

const router = Router();

type ManusStatus = 'completed' | 'failed' | 'cancelled';

interface ManusWebhookPayload {
  task_id: string;
  status: ManusStatus;
  result?: string;
  error?: string;
  metadata?: {
    linear_issue_id?: string;
    linear_team_id?: string;
    workspace_id?: string;
  };
}

// Extend Express Request to expose the raw body captured by the json middleware verify callback.
interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

function verifyManusSignature(rawBody: Buffer, signature: string): boolean {
  const secret = process.env.MANUS_WEBHOOK_SECRET;
  if (!secret) return true; // Skip verification when secret is not configured

  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signature);

  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

function formatManusResult(payload: ManusWebhookPayload): string {
  const lines: string[] = ['## Manus Task Result\n'];

  if (payload.status === 'completed') {
    lines.push('**Status:** Completed\n');
    if (payload.result) {
      lines.push(payload.result);
    }
  } else if (payload.status === 'failed') {
    lines.push('**Status:** Failed\n');
    if (payload.error) {
      lines.push(`**Error:** ${payload.error}`);
    }
  } else {
    lines.push(`**Status:** ${payload.status}\n`);
  }

  lines.push('\n---');
  lines.push(`*Task ID: \`${payload.task_id}\` — Processed by Linear-Manus Bridge*`);

  return lines.join('\n');
}

/**
 * POST /webhook/manus
 * Receives task-completion callbacks from Manus, posts the result as a
 * Linear comment, and transitions the issue state accordingly.
 */
router.post('/manus', async (req: RawBodyRequest, res: Response): Promise<void> => {
  const signature = req.headers['x-manus-signature'] as string | undefined;
  const rawBody = req.rawBody;

  if (signature) {
    if (!rawBody) {
      res.status(500).json({ error: 'Raw body unavailable for signature verification' });
      return;
    }
    if (!verifyManusSignature(rawBody, signature)) {
      res.status(401).json({ error: 'Invalid webhook signature' });
      return;
    }
  }

  const payload = req.body as ManusWebhookPayload;

  if (!payload?.task_id) {
    res.status(400).json({ error: 'Missing required field: task_id' });
    return;
  }

  // Resolve Linear context: prefer in-memory task store, fall back to payload metadata.
  const stored = consumeTask(payload.task_id);
  const issueId = stored?.linearIssueId ?? payload.metadata?.linear_issue_id;
  const teamId = stored?.linearTeamId ?? payload.metadata?.linear_team_id;
  const workspaceId = stored?.workspaceId ?? payload.metadata?.workspace_id;

  if (!issueId || !workspaceId) {
    res.status(422).json({
      error: 'Cannot resolve Linear issue context from task_id or payload metadata',
    });
    return;
  }

  let accessToken: string;
  try {
    accessToken = await getValidToken(workspaceId);
  } catch (err) {
    res.status(503).json({ error: (err as Error).message });
    return;
  }

  // Post result comment on the Linear issue.
  const commentBody = formatManusResult(payload);
  try {
    await postComment(issueId, commentBody, accessToken);
  } catch (err) {
    console.error('Failed to post Linear comment:', err);
    res.status(502).json({ error: `Comment failed: ${(err as Error).message}` });
    return;
  }

  // Transition issue state when the team ID is available.
  if (teamId && payload.status !== 'cancelled') {
    const targetStateName =
      payload.status === 'completed'
        ? (process.env.LINEAR_COMPLETION_STATE ?? 'Done')
        : (process.env.LINEAR_FAILURE_STATE ?? 'Cancelled');

    try {
      const stateId = await findStateIdByName(teamId, targetStateName, accessToken);
      if (stateId) {
        await updateIssueState(issueId, stateId, accessToken);
      } else {
        console.warn(`State "${targetStateName}" not found for team ${teamId}`);
      }
    } catch (err) {
      // Log but do not fail — the comment was already posted successfully.
      console.error('Failed to update issue state:', err);
    }
  }

  res.json({ ok: true });
});

export default router;
