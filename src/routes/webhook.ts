import { Router, Request, Response } from 'express';
import {
  consumeTask,
  getTask,
  storeTask,
  updateProgressCommentId,
  updateQuestionCommentId,
} from '../services/taskStore';
import { getValidToken } from '../services/linearAuth';
import {
  postComment,
  updateComment,
  findStateIdByName,
  updateIssueState,
} from '../services/linearClient';
import { verifyManusWebhookSignature } from '../services/manusWebhookVerifier';
import { createAgentActivity, updateAgentSession } from '../services/linearAgentSession';

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

interface ManusCreatedDetail {
  task_id: string;
  task_title?: string;
  task_url?: string;
}

interface ManusCreatedPayload {
  event_type?: 'task_created';
  task_detail?: ManusCreatedDetail;
  task_id?: string;
}

/**
 * Build the full public URL for the current request.
 * Railway (and most reverse proxies) set the X-Forwarded-Proto and Host headers,
 * so we reconstruct the URL from those rather than trusting req.protocol which
 * may report 'http' behind a TLS-terminating proxy.
 *
 * Falls back to SERVICE_BASE_URL env var if set, which is the recommended
 * approach for Railway deployments.
 */
function buildWebhookUrl(req: Request): string {
  const baseUrl = process.env.SERVICE_BASE_URL?.replace(/\/$/, '');
  if (baseUrl) {
    return `${baseUrl}${req.originalUrl}`;
  }
  const proto = (req.headers['x-forwarded-proto'] as string) ?? req.protocol ?? 'https';
  const host = (req.headers['x-forwarded-host'] as string) ?? req.headers.host ?? 'localhost';
  return `${proto}://${host}${req.originalUrl}`;
}

/**
 * Verify the RSA-SHA256 signature on a Manus webhook request.
 * Returns true if verification passes, false otherwise.
 * Logs a warning and returns true (permissive) if the required headers are absent,
 * allowing the service to operate without verification during initial setup.
 */
async function checkManusSignature(req: RawBodyRequest, res: Response): Promise<boolean> {
  const signature = req.headers['x-webhook-signature'] as string | undefined;
  const timestamp = req.headers['x-webhook-timestamp'] as string | undefined;
  const rawBody = req.rawBody;

  // If neither security header is present, Manus has not sent a signed request.
  // This can happen during the initial webhook registration verification ping.
  if (!signature && !timestamp) {
    return true;
  }

  if (!signature || !timestamp) {
    res.status(401).json({ error: 'Unauthorized: missing required signature headers' });
    return false;
  }

  if (!rawBody) {
    res.status(500).json({ error: 'Raw body unavailable for signature verification' });
    return false;
  }

  const webhookUrl = buildWebhookUrl(req);
  const valid = await verifyManusWebhookSignature(rawBody, signature, timestamp, webhookUrl);

  if (!valid) {
    res.status(401).json({ error: 'Unauthorized: invalid webhook signature' });
    return false;
  }

  return true;
}

function formatProgressComment(detail: ManusProgressDetail, taskId: string): string {
  const message = detail.message?.trim() || 'Progress update received from Manus.';
  const lines: string[] = ['## Manus Progress', ''];
  if (detail.progress_type) {
    lines.push(`**Type:** ${detail.progress_type}`, '');
  }
  lines.push(message, '');
  lines.push('---');
  lines.push(`*Task ID: \`${taskId}\` — Linear-Manus Bridge*`);
  return lines.join('\n');
}

function formatStoppedComment(detail: ManusTaskDetail, outcome: string): string {
  const lines: string[] = [`## Manus Task ${outcome}`, ''];
  if (detail.task_title) {
    lines.push(`**Task:** ${detail.task_title}`, '');
  }
  if (detail.task_url) {
    lines.push(`**View in Manus:** ${detail.task_url}`, '');
  }
  if (detail.message) {
    lines.push(detail.message.trim(), '');
  }
  if (detail.attachments && detail.attachments.length > 0) {
    lines.push('**Attachments:**', '');
    for (const att of detail.attachments) {
      lines.push(`- [${att.file_name}](${att.url})`);
    }
    lines.push('');
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
  if (!(await checkManusSignature(req, res))) return;

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

  // Emit agent activity for real-time visibility in the agent session UI
  const sessionId = stored?.agentSessionId;
  if (sessionId) {
    const progressMessage = detail?.message?.trim() || 'Working…';
    await createAgentActivity(sessionId, {
      type: 'action',
      action: detail?.progress_type === 'plan_update' ? 'Plan update' : 'Working',
      result: progressMessage,
    }, accessToken).catch((err) =>
      console.error('[webhook/manus/progress] Failed to emit activity:', err),
    );
  }

  res.json({ ok: true });
});

/**
 * POST /webhook/manus
 * Receives task lifecycle callbacks from Manus (task_created, task_stopped),
 * posts results as Linear comments, emits agent activities, and transitions
 * the issue state accordingly.
 */
router.post('/manus', async (req: RawBodyRequest, res: Response): Promise<void> => {
  if (!(await checkManusSignature(req, res))) return;

  // Handle task_created events (acknowledge and set external URL)
  const eventType = (req.body as { event_type?: string }).event_type;
  if (eventType === 'task_created') {
    const createdPayload = req.body as ManusCreatedPayload;
    const createdDetail = createdPayload.task_detail;
    const createdTaskId = createdDetail?.task_id ?? createdPayload.task_id;
    if (!createdTaskId) {
      res.status(400).json({ error: 'Missing task_id in task_created event' });
      return;
    }

    const stored = getTask(createdTaskId);
    if (stored?.agentSessionId && stored.workspaceId) {
      try {
        const accessToken = await getValidToken(stored.workspaceId);
        if (createdDetail?.task_url) {
          await updateAgentSession(stored.agentSessionId, {
            externalUrls: [{ label: 'View in Manus', url: createdDetail.task_url }],
          }, accessToken).catch(() => {});
        }
        if (createdDetail?.task_title) {
          await createAgentActivity(stored.agentSessionId, {
            type: 'thought',
            body: `Manus is working on: ${createdDetail.task_title}`,
          }, accessToken).catch(() => {});
        }
      } catch (err) {
        console.error('[webhook/manus] task_created activity failed:', err);
      }
    }

    console.log('[webhook/manus] task_created acknowledged:', createdTaskId);
    res.json({ ok: true });
    return;
  }

  // Handle task_progress events inline (Manus sends all events to the same URL)
  if (eventType === 'task_progress') {
    const progressPayload = req.body as ManusProgressPayload;
    const progressDetail = progressPayload.progress_detail;
    const progressTaskId = progressDetail?.task_id ?? progressPayload.task_id;

    if (!progressTaskId) {
      res.status(400).json({ error: 'Missing task_id in task_progress event' });
      return;
    }

    const stored = getTask(progressTaskId);
    if (stored?.agentSessionId && stored.workspaceId) {
      try {
        const accessToken = await getValidToken(stored.workspaceId);
        const progressMessage = progressDetail?.message?.trim() || 'Working…';
        await createAgentActivity(stored.agentSessionId, {
          type: 'action',
          action: progressDetail?.progress_type === 'plan_update' ? 'Plan update' : 'Working',
          result: progressMessage,
        }, accessToken).catch(() => {});
      } catch (err) {
        console.error('[webhook/manus] task_progress activity failed:', err);
      }
    }

    console.log('[webhook/manus] task_progress acknowledged:', progressTaskId);
    res.json({ ok: true });
    return;
  }

  const payload = req.body as ManusStoppedPayload;
  const detail = payload.task_detail;
  const taskId = detail?.task_id ?? payload.task_id;

  if (!taskId) {
    res.status(400).json({ error: 'Missing required field: task_id' });
    return;
  }

  const existing = getTask(taskId);
  const stored = existing ?? undefined;
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
    const commentId = await postComment(issueId, commentBody, accessToken);
    if (stopReason === 'ask' && commentId) {
      updateQuestionCommentId(taskId, commentId);
    }
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

  // Emit agent activity to close out the session in Linear's UI
  const sessionId = stored?.agentSessionId;
  if (sessionId) {
    if (stopReason === 'ask') {
      // Manus is asking for input — emit a response so the user sees the question
      const question = detail?.message?.trim() || 'Manus needs more information to continue.';
      await createAgentActivity(sessionId, {
        type: 'response',
        body: question,
      }, accessToken).catch((err) =>
        console.error('[webhook/manus] Failed to emit ask activity:', err),
      );
    } else {
      // Task completed — emit a final response
      const resultBody = detail?.message?.trim() || payload.result || 'Task completed.';
      const taskUrl = detail?.task_url;
      const attachmentLinks = detail?.attachments?.length
        ? '\n\n**Attachments:**\n' + detail.attachments.map((a) => `- [${a.file_name}](${a.url})`).join('\n')
        : '';
      const viewLink = taskUrl ? `\n\n[View full results in Manus](${taskUrl})` : '';

      await createAgentActivity(sessionId, {
        type: 'response',
        body: `${resultBody}${attachmentLinks}${viewLink}`,
      }, accessToken).catch((err) =>
        console.error('[webhook/manus] Failed to emit response activity:', err),
      );
    }
  }

  if (stopReason !== 'ask') {
    consumeTask(taskId);
  }

  res.json({ ok: true });
});

export default router;
