interface ManusTaskResponse {
  task_id: string;
  task_title?: string;
  task_url?: string;
  share_url?: string;
}

const MANUS_API_BASE_URL = process.env.MANUS_API_BASE_URL ?? 'https://api.manus.ai';

export interface ManusTaskOptions {
  agentProfile?: string;
  taskMode?: string;
}

export async function createTask(
  prompt: string,
  options: ManusTaskOptions = {},
): Promise<{ taskId: string; taskUrl?: string }> {
  const apiKey = process.env.MANUS_API_KEY;
  if (!apiKey) {
    throw new Error('MANUS_API_KEY is not configured');
  }

  const response = await fetch(`${MANUS_API_BASE_URL}/v1/tasks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      API_KEY: apiKey,
    },
    body: JSON.stringify({
      prompt,
      agentProfile: options.agentProfile ?? process.env.MANUS_AGENT_PROFILE ?? 'manus-1.6',
      taskMode: options.taskMode ?? process.env.MANUS_TASK_MODE ?? 'agent',
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Manus task creation failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as ManusTaskResponse;

  if (!data.task_id) {
    throw new Error('Manus response missing task_id');
  }

  return { taskId: data.task_id, taskUrl: data.task_url };
}
