import { createHmac, timingSafeEqual } from 'crypto';
import { Router, Request, Response } from 'express';
import {
  consumeTask,
  getTask,
  storeTask,
  updateProgressCommentId,
} from '../services/taskStore';
import { getValidToken } from '../services/linearAuth';
import {
  postComment,
  updateComment,
  findStateIdByName,
  updateIssueState,
} from '../services/linearClient';

const router = Router();

// Extend Express Request to expose the raw body captured by the json middleware verify callback.
interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

type ManusStopReason = 'finish' | 'ask';

interface ManusTaskAttachment {
  file_name: string;
  url: string;
  size_bytes: number;
}

interface ManusTaskDetail {
  task_id: string;
  task_title?: string;
  task_url?: string;
  message?: string;
  attachments?: ManusTaskAttachment[];
  stop_reason?: ManusStopReason;
}

interface ManusStoppedPayload {
  event_type?: 'task_stopped';
  task_detail?: ManusTaskDetail;
  task_id?: string;
  status?: string;
  result?: string;
  error?: string;
  metadata?: {
    linear_issue_id?: string;
    linear_team_id?: string;
    workspace_id?: string;
  };
}

interface ManusProgressDetail {
  task_id: string;
  progress_type?: string;
  message?: string;
}

interface ManusProgressPayload {
  event_type?: 'task_progress';
  progress_detail?: ManusProgressDetail;
  task_id?: string;
  metadata?: {
    linear_issue_id?: string;
    linear_team_id?: string;
    workspace_id?: string;
  };
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

function formatProgressComment(detail: ManusProgressDetail, taskId: string): string {
  const message = detail.message?.trim() || 'Progress update received from Manus.';
  const lines: string[] = ['## Manus Progress', ''];

  if (detail.progress_type) {
    lines.push(`**Type:** ${detail.progress_type}`, '');
  }

  lines.push(message, '');
  lines.push(`_Last update: ${new Date().toISOString()}_`, '');
  lines.push('---');
  lines.push(`*Task ID: \`${taskId}\` — Progress update*`);

  return lines.join('\n');
}

function formatStoppedComment(detail: ManusTaskDetail, statusLabel: string): string {
  const lines: string[] = ['## Manus Task Result', ''];
  lines.push(`**Status:** ${statusLabel}`, '');

  if (detail.message) {
    lines.push(detail.message, '');
  }

  if (detail.attachments?.length) {
    lines.push('**Attachments:**');
    for (const attachment of detail.attachments) {
      lines.push(
        `- [${attachment.file_name}](${attachment.url}) (${attachment.size_bytes} bytes)`,
      );
    }
    lines.push('');
  }

  if (detail.task_url) {
    lines.push(`**Task URL:** ${detail.task_url}`, '');
  }

  lines.push('---');
  lines.push(`*Task ID: \`${detail.task_id}\` — Processed by Linear-Manus Bridge*`);

  return lines.join('\n');
}

function formatLegacyResult(
  taskId: string,
  status: string,
  result?: string,
  error?: string,
): string {
  const lines: string[] = ['## Manus Task Result', ''];
  lines.push(`**Status:** ${status}`, '');
  if (status === 'completed' && result) {
    lines.push(result, '');
  }
  if (status === 'failed' && error) {
    lines.push(`**Error:** ${error}`, '');
  }
  lines.push('---');
  lines.push(`*Task ID: \`${taskId}\` — Processed by Linear-Manus Bridge*`);
  return lines.join('\n');
}

/**
 * POST /webhook/manus/progress
 * Receives Manus progress updates and updates a single Linear comment.
 */
router.post('/manus/progress', async (req: RawBodyRequest, res: Response): Promise<void> => {
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

  const payload = req.body as ManusProgressPayload;
  if (payload.event_type && payload.event_type !== 'task_progress') {
    res.status(400).json({ error: `Unexpected event_type: ${payload.event_type}` });
    return;
  }

  const detail = payload.progress_detail;
  const taskId = detail?.task_id ?? payload.task_id;

  if (!taskId) {
    res.status(400).json({ error: 'Missing required field: task_id' });
    return;
  }

  let stored = getTask(taskId);
  if (!stored && payload.metadata?.linear_issue_id && payload.metadata.workspace_id) {
    storeTask(taskId, {
      linearIssueId: payload.metadata.linear_issue_id,
      linearTeamId: payload.metadata.linear_team_id,
      workspaceId: payload.metadata.workspace_id,
    });
    stored = getTask(taskId);
  }

  const issueId = stored?.linearIssueId ?? payload.metadata?.linear_issue_id;
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

  const commentBody = formatProgressComment(
    detail ?? { task_id: taskId, message: 'Progress update received.' },
    taskId,
  );

  try {
    if (stored?.progressCommentId) {
      await updateComment(stored.progressCommentId, commentBody, accessToken);
    } else {
      const commentId = await postComment(issueId, commentBody, accessToken);
      if (commentId) {
        updateProgressCommentId(taskId, commentId);
      }
    }
  } catch (err) {
    console.error('Failed to update progress comment:', err);
    res.status(502).json({ error: `Comment failed: ${(err as Error).message}` });
    return;
  }

  res.json({ ok: true });
});

/**
 * POST /webhook/manus
 * Receives task completion callbacks from Manus, posts the final result as a
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

  const payload = req.body as ManusStoppedPayload;
  const detail = payload.task_detail;
  const taskId = detail?.task_id ?? payload.task_id;

  if (!taskId) {
    res.status(400).json({ error: 'Missing required field: task_id' });
    return;
  }

  const stored = consumeTask(taskId);
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

  const stopReason = detail?.stop_reason;
  let commentBody: string;
  let targetStateName: string | null = null;

  if (detail) {
    if (stopReason === 'ask') {
      commentBody = formatStoppedComment(detail, 'Needs Input');
      targetStateName = process.env.LINEAR_NEEDS_INPUT_STATE ?? 'Needs Input';
    } else {
      commentBody = formatStoppedComment(detail, 'Completed');
      targetStateName = process.env.LINEAR_COMPLETION_STATE ?? 'Done';
    }
  } else if (payload.status) {
    commentBody = formatLegacyResult(taskId, payload.status, payload.result, payload.error);
    if (payload.status === 'completed') {
      targetStateName = process.env.LINEAR_COMPLETION_STATE ?? 'Done';
    } else if (payload.status === 'failed') {
      targetStateName = process.env.LINEAR_FAILURE_STATE ?? 'Cancelled';
    }
  } else {
    res.status(400).json({ error: 'Invalid Manus webhook payload' });
    return;
  }

  try {
    await postComment(issueId, commentBody, accessToken);
  } catch (err) {
    console.error('Failed to post Linear comment:', err);
    res.status(502).json({ error: `Comment failed: ${(err as Error).message}` });
    return;
  }

  if (teamId && targetStateName) {
    try {
      const stateId = await findStateIdByName(teamId, targetStateName, accessToken);
      if (stateId) {
        await updateIssueState(issueId, stateId, accessToken);
      } else {
        console.warn(`State "${targetStateName}" not found for team ${teamId}`);
      }
    } catch (err) {
      console.error('Failed to update issue state:', err);
    }
  }

  res.json({ ok: true });
});

export default router;
