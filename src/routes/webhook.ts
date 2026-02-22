import { createHmac, timingSafeEqual } from 'crypto';
import express, { Router, Request, Response } from 'express';
import { buildIssuePrompt, submitManusTask } from '../services/manus';

const router = Router();

// Capture raw body as Buffer for HMAC verification before JSON parsing
router.use(express.raw({ type: 'application/json' }));

// Linear webhook event actions we care about
const HANDLED_ACTIONS = new Set(['create', 'update']);

interface LinearIssueData {
  id: string;
  title: string;
  description?: string | null;
  number?: number;
  team?: {
    key?: string;
  };
}

interface LinearWebhookPayload {
  action: string;
  type: string;
  data: LinearIssueData;
  organizationId?: string;
  webhookTimestamp?: number;
}

/**
 * Validate the Linear-Signature header using HMAC-SHA256.
 */
function verifySignature(rawBody: Buffer, signature: string): boolean {
  const secret = process.env.LINEAR_WEBHOOK_SECRET;
  if (!secret) {
    console.warn('LINEAR_WEBHOOK_SECRET is not set; skipping signature verification');
    return true;
  }

  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');

  try {
    return timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

/**
 * POST /webhook/linear
 * Receives Linear webhook events, validates the HMAC signature, and forwards
 * relevant issue events to Manus as structured prompts.
 */
router.post('/linear', async (req: Request, res: Response): Promise<void> => {
  const signature = req.headers['linear-signature'] as string | undefined;

  if (!signature) {
    res.status(400).json({ error: 'Missing Linear-Signature header' });
    return;
  }

  const rawBody = req.body as Buffer;

  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
    res.status(400).json({ error: 'Empty or invalid request body' });
    return;
  }

  if (!verifySignature(rawBody, signature)) {
    res.status(401).json({ error: 'Invalid webhook signature' });
    return;
  }

  let payload: LinearWebhookPayload;
  try {
    payload = JSON.parse(rawBody.toString('utf-8')) as LinearWebhookPayload;
  } catch {
    res.status(400).json({ error: 'Invalid JSON payload' });
    return;
  }

  // Only handle Issue events with relevant actions
  if (payload.type !== 'Issue' || !HANDLED_ACTIONS.has(payload.action)) {
    res.json({ ok: true, skipped: true });
    return;
  }

  const issue = payload.data;

  if (!issue?.id || !issue?.title) {
    res.status(400).json({ error: 'Payload missing required issue fields (id, title)' });
    return;
  }

  const prompt = buildIssuePrompt({
    id: issue.id,
    title: issue.title,
    description: issue.description,
    number: issue.number,
    teamKey: issue.team?.key,
  });

  try {
    const result = await submitManusTask({
      prompt,
      metadata: {
        linearIssueId: issue.id,
        action: payload.action,
        organizationId: payload.organizationId ?? '',
      },
    });

    console.log(`Manus task created for issue ${issue.id}: taskId=${result.taskId}`);
    res.json({ ok: true, taskId: result.taskId });
  } catch (err) {
    console.error('Failed to submit Manus task:', (err as Error).message);
    res.status(502).json({ error: (err as Error).message });
  }
});

export default router;
