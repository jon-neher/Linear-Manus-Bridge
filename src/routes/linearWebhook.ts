import { createHmac, timingSafeEqual } from 'crypto';
import { Router, Request, Response } from 'express';
import { getValidToken } from '../services/linearAuth';
import {
  findStateIdByName,
  getIssueDetails,
  updateIssueState,
} from '../services/linearClient';
import { createTask } from '../services/manusClient';
import { storeTask } from '../services/taskStore';

const router = Router();

interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

// ─── AgentSessionEvent payload types ────────────────────────────────────────

interface AgentSessionIssue {
  id: string;
  title?: string;
  description?: string | null;
  teamId?: string;
  team?: { id?: string; organizationId?: string; organization?: { id?: string } | null } | null;
}

interface AgentSessionWebhookPayload {
  id: string;
  issue?: AgentSessionIssue | null;
  status?: string;
}

interface AgentSessionEventPayload {
  type: 'AgentSessionEvent';
  action: 'created' | 'prompted';
  organizationId: string;
  agentSession: AgentSessionWebhookPayload;
  promptContext?: string | null;
  webhookId?: string;
  webhookTimestamp?: number;
}

// ─── Legacy Issue assignment payload types ───────────────────────────────────

interface LinearIssueData {
  id?: string;
  title?: string;
  description?: string | null;
  team?: { id?: string; organization?: { id?: string } | null; organizationId?: string } | null;
  teamId?: string;
  assignee?: { id?: string; name?: string; type?: string } | null;
  assigneeId?: string;
  assigneeName?: string;
  assigneeType?: string;
  organizationId?: string;
}

interface LinearIssuePayload {
  type?: string;
  action?: string;
  data?: Record<string, unknown>;
  organizationId?: string;
  updatedFields?: string[];
}

// ─── Signature verification ──────────────────────────────────────────────────

function extractSignatureCandidates(signatureHeader: string): string[] {
  const candidates: string[] = [];
  for (const part of signatureHeader.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    if (trimmed.includes('=')) {
      const [key, value] = trimmed.split('=');
      const lowerKey = key.trim().toLowerCase();
      if (lowerKey === 'sha256' || lowerKey === 'v1') {
        candidates.push(value.trim());
      }
    } else {
      candidates.push(trimmed);
    }
  }
  return candidates;
}

function verifyLinearSignature(rawBody: Buffer, signatureHeader?: string): boolean {
  const secret = process.env.LINEAR_WEBHOOK_SECRET;
  if (!secret) return true;
  if (!signatureHeader) return false;

  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const candidates = extractSignatureCandidates(signatureHeader);
  return candidates.some((candidate) => {
    if (candidate.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(candidate), Buffer.from(expected));
  });
}

// ─── Legacy helpers ──────────────────────────────────────────────────────────

function extractIssueData(payload: LinearIssuePayload): LinearIssueData | undefined {
  const data = payload.data as LinearIssueData | undefined;
  if (!data) return undefined;
  if ((data as { issue?: LinearIssueData }).issue) {
    return (data as { issue: LinearIssueData }).issue;
  }
  return data;
}

function isManusAssignment(
  assigneeId?: string,
  assigneeName?: string,
  assigneeType?: string,
): boolean {
  const configuredId = process.env.LINEAR_MANUS_ASSIGNEE_ID;
  if (configuredId) return assigneeId === configuredId;
  if (assigneeName && assigneeName.toLowerCase().includes('manus')) return true;
  if (assigneeType) {
    const normalized = assigneeType.toLowerCase();
    return normalized === 'app' || normalized === 'application' || normalized === 'bot';
  }
  return false;
}

function buildPromptFromDetails(
  title: string,
  description: string | null | undefined,
  comments: Array<{ body: string; authorName?: string }>,
): string {
  const lines: string[] = [];
  lines.push(`Title: ${title}`);
  lines.push('');
  lines.push('Description:');
  lines.push(description?.trim() ? description : '(none)');
  lines.push('');
  lines.push('Comments:');
  if (!comments.length) {
    lines.push('(none)');
  } else {
    for (const comment of comments) {
      const body = comment.body?.trim() || '(empty comment)';
      const prefix = comment.authorName ? `${comment.authorName}: ` : '';
      lines.push(`- ${prefix}${body}`);
    }
  }
  return lines.join('\n');
}

// ─── Route ───────────────────────────────────────────────────────────────────

/**
 * POST /linear/webhook
 *
 * Handles two event types from Linear:
 *
 * 1. AgentSessionEvent (action: "created") — fired when a user delegates an
 *    issue to the Manus app via the agent session UI. This is the primary
 *    trigger for creating a Manus task.
 *
 * 2. Issue (legacy) — fired when an issue is assigned to the Manus app via
 *    a standard assignee change. Kept for backwards compatibility.
 */
router.post('/', async (req: RawBodyRequest, res: Response): Promise<void> => {
  console.log('[linear/webhook] Received request', {
    method: req.method,
    headers: {
      'content-type': req.headers['content-type'],
      'linear-signature': req.headers['linear-signature'],
      'x-linear-signature': req.headers['x-linear-signature'],
    },
    bodyPreview: JSON.stringify(req.body)?.slice(0, 300),
  });
  const signatureHeader =
    (req.headers['linear-signature'] as string | undefined) ??
    (req.headers['x-linear-signature'] as string | undefined);
  const rawBody = req.rawBody;

  if (!rawBody) {
    res.status(500).json({ error: 'Raw body unavailable for signature verification' });
    return;
  }

  console.log('[linear/webhook] Signature header:', signatureHeader ?? '(none)');
  if (!verifyLinearSignature(rawBody, signatureHeader)) {
    console.error('[linear/webhook] Signature verification FAILED');
    res.status(401).json({ error: 'Invalid webhook signature' });
    return;
  }
  console.log('[linear/webhook] Signature OK');

  const body = req.body as AgentSessionEventPayload | LinearIssuePayload;
  const eventType = (body as { type?: string }).type;
  console.log('[linear/webhook] eventType:', eventType);

  // ── Path 1: AgentSessionEvent ──────────────────────────────────────────────
  if (eventType === 'AgentSessionEvent') {
    console.log('[linear/webhook] Handling AgentSessionEvent');
    const payload = body as AgentSessionEventPayload;

    console.log('[linear/webhook] AgentSessionEvent action:', payload.action);
    if (payload.action !== 'created') {
      console.log('[linear/webhook] Ignoring non-created action:', payload.action);
      res.json({ ok: true, ignored: true, reason: `action=${payload.action}` });
      return;
    }

    const issueId = payload.agentSession?.issue?.id;
    console.log('[linear/webhook] agentSession.issue.id:', issueId);
    if (!issueId) {
      console.error('[linear/webhook] Missing agentSession.issue.id');
      res.status(400).json({ error: 'AgentSessionEvent missing agentSession.issue.id' });
      return;
    }

    const workspaceId = payload.organizationId;
    console.log('[linear/webhook] organizationId:', workspaceId);
    if (!workspaceId) {
      console.error('[linear/webhook] Missing organizationId');
      res.status(422).json({ error: 'AgentSessionEvent missing organizationId' });
      return;
    }

    let accessToken: string;
    try {
      console.log('[linear/webhook] Fetching token for workspace:', workspaceId);
      accessToken = await getValidToken(workspaceId);
      console.log('[linear/webhook] Token fetched OK');
    } catch (err) {
      console.error('[linear/webhook] getValidToken failed:', (err as Error).message);
      res.status(503).json({ error: (err as Error).message });
      return;
    }

    let prompt: string;
    let teamId: string | undefined =
      payload.agentSession.issue?.teamId ?? payload.agentSession.issue?.team?.id;

    if (payload.promptContext) {
      prompt = payload.promptContext;
      if (!teamId) {
        try {
          const details = await getIssueDetails(issueId, accessToken);
          teamId = details.teamId ?? undefined;
        } catch {
          // Non-fatal — state transition will be skipped.
        }
      }
    } else {
      try {
        const details = await getIssueDetails(issueId, accessToken);
        teamId = details.teamId ?? teamId;
        prompt = buildPromptFromDetails(details.title, details.description, details.comments);
      } catch (err) {
        res.status(502).json({ error: (err as Error).message });
        return;
      }
    }

    if (teamId) {
      const inProgressState = process.env.LINEAR_IN_PROGRESS_STATE ?? 'In Progress';
      try {
        const stateId = await findStateIdByName(teamId, inProgressState, accessToken);
        if (stateId) {
          await updateIssueState(issueId, stateId, accessToken);
        } else {
          console.warn(`State "${inProgressState}" not found for team ${teamId}`);
        }
      } catch (err) {
        console.error('Failed to update issue state:', err);
      }
    }

    let taskId: string;
    try {
      const result = await createTask(prompt!);
      taskId = result.taskId;
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
      return;
    }

    storeTask(taskId, { linearIssueId: issueId, linearTeamId: teamId, workspaceId });
    console.log('[linear/webhook] Task created successfully:', taskId);
    res.json({ ok: true, taskId });
    return;
  }

  // ── Path 2: Legacy Issue assignment ───────────────────────────────────────
  const legacyPayload = body as LinearIssuePayload;
  const legacyType = legacyPayload.type?.toLowerCase();

  if (legacyType && legacyType !== 'issue') {
    res.json({ ok: true, ignored: true, reason: `type=${legacyType}` });
    return;
  }

  const issueData = extractIssueData(legacyPayload);
  const issueId = issueData?.id;
  if (!issueId) {
    res.status(400).json({ error: 'Missing issue id in webhook payload' });
    return;
  }

  if (
    legacyPayload.updatedFields?.length &&
    !legacyPayload.updatedFields.includes('assigneeId') &&
    !legacyPayload.updatedFields.includes('assignee')
  ) {
    res.json({ ok: true, ignored: true });
    return;
  }

  const assigneeId = issueData?.assignee?.id ?? issueData?.assigneeId;
  const assigneeName = issueData?.assignee?.name ?? issueData?.assigneeName;
  const assigneeType = issueData?.assignee?.type ?? issueData?.assigneeType;

  if (!isManusAssignment(assigneeId, assigneeName, assigneeType)) {
    res.json({ ok: true, ignored: true });
    return;
  }

  const workspaceId =
    legacyPayload.organizationId ??
    issueData?.organizationId ??
    issueData?.team?.organization?.id ??
    issueData?.team?.organizationId;

  if (!workspaceId) {
    res.status(422).json({ error: 'Missing workspace/organization id in webhook payload' });
    return;
  }

  let accessToken: string;
  try {
    accessToken = await getValidToken(workspaceId);
  } catch (err) {
    res.status(503).json({ error: (err as Error).message });
    return;
  }

  let issueDetails;
  try {
    issueDetails = await getIssueDetails(issueId, accessToken);
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
    return;
  }

  const teamId = issueDetails.teamId ?? issueData?.team?.id ?? issueData?.teamId;
  if (teamId) {
    const inProgressState = process.env.LINEAR_IN_PROGRESS_STATE ?? 'In Progress';
    try {
      const stateId = await findStateIdByName(teamId, inProgressState, accessToken);
      if (stateId) {
        await updateIssueState(issueId, stateId, accessToken);
      } else {
        console.warn(`State "${inProgressState}" not found for team ${teamId}`);
      }
    } catch (err) {
      console.error('Failed to update issue state:', err);
    }
  }

  const prompt = buildPromptFromDetails(
    issueDetails.title,
    issueDetails.description,
    issueDetails.comments,
  );

  let taskId: string;
  try {
    const result = await createTask(prompt);
    taskId = result.taskId;
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
    return;
  }

  storeTask(taskId, { linearIssueId: issueId, linearTeamId: teamId, workspaceId });
  res.json({ ok: true, taskId });
});

export default router;
