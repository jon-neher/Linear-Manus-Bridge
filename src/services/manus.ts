const MANUS_API_URL = process.env.MANUS_API_URL ?? 'https://api.manus.im/v1/tasks';

export interface ManusTaskPayload {
  prompt: string;
  metadata?: Record<string, string>;
}

export interface ManusTaskResponse {
  taskId: string;
  status: string;
}

/**
 * Build a Manus prompt from a Linear issue.
 */
export function buildIssuePrompt(issue: {
  id: string;
  title: string;
  description?: string | null;
  number?: number;
  teamKey?: string;
}): string {
  const identifier = issue.teamKey && issue.number != null
    ? `${issue.teamKey}-${issue.number}`
    : issue.id;

  const lines = [
    `You have been assigned a new Linear issue.`,
    ``,
    `Issue: ${identifier}`,
    `Title: ${issue.title}`,
  ];

  if (issue.description) {
    lines.push(``, `Description:`, issue.description);
  }

  lines.push(
    ``,
    `Please analyze this issue and provide a solution or implementation plan.`,
  );

  return lines.join('\n');
}

/**
 * Submit a task to the Manus API.
 */
export async function submitManusTask(payload: ManusTaskPayload): Promise<ManusTaskResponse> {
  const apiKey = process.env.MANUS_API_KEY;
  if (!apiKey) {
    throw new Error('MANUS_API_KEY is not configured');
  }

  const response = await fetch(MANUS_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Manus API request failed (${response.status}): ${text}`);
  }

  return response.json() as Promise<ManusTaskResponse>;
}
