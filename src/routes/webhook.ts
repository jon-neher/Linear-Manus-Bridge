import { createHmac } from 'crypto';
import { Router, Request, Response } from 'express';
import { createTask, pollTaskUntilDone, TaskDetail } from '../services/manus';
import { getValidToken } from '../services/linearAuth';

const router = Router();

const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';

interface LinearWebhookPayload {
  action: string;
  type: string;
  data: {
    id: string;
    identifier: string;
    title: string;
    description?: string;
    url: string;
    priority: number;
    teamId: string;
    labelIds?: string[];
    assigneeId?: string;
    state?: { name: string };
  };
  organizationId: string;
}

function verifyWebhookSignature(body: Buffer, signature: string | undefined): boolean {
  const secret = process.env.LINEAR_WEBHOOK_SECRET;
  if (!secret) return false;
  if (!signature) return false;

  const hmac = createHmac('sha256', secret);
  hmac.update(body);
  const digest = hmac.digest('hex');
  return digest === signature;
}

function buildManusPrompt(issue: LinearWebhookPayload['data']): string {
  const parts = [
    `Linear Issue: ${issue.identifier} — ${issue.title}`,
    `URL: ${issue.url}`,
  ];

  if (issue.description) {
    parts.push(`\nDescription:\n${issue.description}`);
  }

  parts.push(
    '\nPlease analyze this issue and provide a detailed plan or solution. ' +
    'Include any relevant code, architecture decisions, or action items.',
  );

  return parts.join('\n');
}

async function postCommentToIssue(
  issueId: string,
  body: string,
  workspaceId: string,
): Promise<void> {
  const token = await getValidToken(workspaceId);

  const mutation = `
    mutation CommentCreate($input: CommentCreateInput!) {
      commentCreate(input: $input) {
        success
      }
    }
  `;

  const response = await fetch(LINEAR_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      query: mutation,
      variables: { input: { issueId, body } },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    console.error(`Failed to post comment to issue ${issueId}: ${text}`);
  }
}

function formatTaskResultComment(task: TaskDetail, taskUrl: string): string {
  const lines = [`**Manus Task ${task.status === 'completed' ? 'Completed' : 'Failed'}**`];
  lines.push(`[View task on Manus](${taskUrl})`);

  if (task.error) {
    lines.push(`\nError: ${task.error}`);
  }

  if (task.output?.length) {
    const textOutputs = task.output
      .flatMap((item) => item.content)
      .filter((c) => c.type === 'output_text' && c.text)
      .map((c) => c.text!);

    if (textOutputs.length) {
      lines.push('\n---\n');
      lines.push(textOutputs.join('\n'));
    }
  }

  return lines.join('\n');
}

/**
 * POST /webhooks/linear
 * Receives webhook events from Linear when issues are created or updated.
 */
router.post('/linear', async (req: Request, res: Response): Promise<void> => {
  const signature = req.headers['linear-signature'] as string | undefined;

  if (process.env.LINEAR_WEBHOOK_SECRET) {
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    if (!rawBody || !verifyWebhookSignature(rawBody, signature)) {
      res.status(401).json({ error: 'Invalid webhook signature' });
      return;
    }
  }

  const payload = req.body as LinearWebhookPayload;

  if (payload.type !== 'Issue') {
    res.json({ ok: true, skipped: true, reason: 'Not an issue event' });
    return;
  }

  if (payload.action !== 'create' && payload.action !== 'update') {
    res.json({ ok: true, skipped: true, reason: `Unhandled action: ${payload.action}` });
    return;
  }

  const issue = payload.data;
  const prompt = buildManusPrompt(issue);

  console.log(`Dispatching issue ${issue.identifier} to Manus...`);

  let taskResponse;
  try {
    taskResponse = await createTask({
      prompt,
      agentProfile: 'manus-1.6',
      taskMode: 'agent',
      createShareableLink: true,
    });
  } catch (err) {
    console.error(`Failed to create Manus task for ${issue.identifier}:`, err);
    res.status(502).json({ error: (err as Error).message });
    return;
  }

  console.log(`Manus task created: ${taskResponse.task_id} — ${taskResponse.task_url}`);

  // Respond immediately; poll asynchronously
  res.json({
    ok: true,
    taskId: taskResponse.task_id,
    taskUrl: taskResponse.task_url,
    shareUrl: taskResponse.share_url,
  });

  // Post an initial comment linking to the Manus task
  try {
    await postCommentToIssue(
      issue.id,
      `**Manus task dispatched**\n[View task on Manus](${taskResponse.task_url})`,
      payload.organizationId,
    );
  } catch (err) {
    console.error(`Failed to post initial comment for ${issue.identifier}:`, err);
  }

  // Poll for completion in the background
  pollTaskUntilDone(taskResponse.task_id, (task) => {
    console.log(`Task ${taskResponse.task_id} status: ${task.status}`);
  })
    .then(async (finalTask) => {
      const comment = formatTaskResultComment(finalTask, taskResponse.task_url);
      await postCommentToIssue(issue.id, comment, payload.organizationId);
      console.log(`Posted result comment for ${issue.identifier}`);
    })
    .catch((err) => {
      console.error(`Error polling task ${taskResponse.task_id}:`, err);
    });
});

export default router;
