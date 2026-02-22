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

interface LinearWebhookPayload {
  type?: string;
  action?: string;
  data?: Record<string, unknown>;
  organizationId?: string;
  updatedFields?: string[];
}

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

function extractIssueData(payload: LinearWebhookPayload): LinearIssueData | undefined {
  const data = payload.data as LinearIssueData | undefined;
  if (!data) return undefined;
  if ((data as { issue?: LinearIssueData }).issue) {
    return (data as { issue: LinearIssueData }).issue;
  }
  return data;
}

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

function isManusAssignment(
  assigneeId?: string,
  assigneeName?: string,
  assigneeType?: string,
): boolean {
  const configuredId = process.env.LINEAR_MANUS_ASSIGNEE_ID;
  if (configuredId) {
    return assigneeId === configuredId;
  }

  if (assigneeName && assigneeName.toLowerCase().includes('manus')) {
    return true;
  }

  if (assigneeType) {
    const normalized = assigneeType.toLowerCase();
    return normalized === 'app' || normalized === 'application' || normalized === 'bot';
  }

  return false;
}

function buildPrompt(
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

/**
 * POST /webhook/linear
 * Receives Linear assignment events and forwards the issue to Manus.
 */
router.post('/linear', async (req: RawBodyRequest, res: Response): Promise<void> => {
  const signatureHeader =
    (req.headers['linear-signature'] as string | undefined)
    ?? (req.headers['x-linear-signature'] as string | undefined);
  const rawBody = req.rawBody;

  if (!rawBody) {
    res.status(500).json({ error: 'Raw body unavailable for signature verification' });
    return;
  }

  if (!verifyLinearSignature(rawBody, signatureHeader)) {
    res.status(401).json({ error: 'Invalid webhook signature' });
    return;
  }

  const payload = req.body as LinearWebhookPayload;
  const eventType = payload.type?.toLowerCase();
  if (eventType && eventType !== 'issue') {
    res.json({ ok: true, ignored: true });
    return;
  }

  const issueData = extractIssueData(payload);
  const issueId = issueData?.id;
  if (!issueId) {
    res.status(400).json({ error: 'Missing issue id in webhook payload' });
    return;
  }

  if (
    payload.updatedFields?.length
    && !payload.updatedFields.includes('assigneeId')
    && !payload.updatedFields.includes('assignee')
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
    payload.organizationId
    ?? issueData?.organizationId
    ?? issueData?.team?.organization?.id
    ?? issueData?.team?.organizationId;

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

  const prompt = buildPrompt(
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

  storeTask(taskId, {
    linearIssueId: issueId,
    linearTeamId: teamId,
    workspaceId,
  });

  res.json({ ok: true, taskId });
});

export default router;
