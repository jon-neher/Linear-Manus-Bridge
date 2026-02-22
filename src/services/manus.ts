const MANUS_API_BASE = 'https://api.manus.ai/v1';

export type AgentProfile = 'manus-1.6' | 'manus-1.6-lite' | 'manus-1.6-max';
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface CreateTaskRequest {
  prompt: string;
  agentProfile?: AgentProfile;
  taskMode?: 'chat' | 'adaptive' | 'agent';
  hideInTaskList?: boolean;
  createShareableLink?: boolean;
}

export interface CreateTaskResponse {
  task_id: string;
  task_title: string;
  task_url: string;
  share_url?: string;
}

export interface TaskOutputContent {
  type: string;
  text?: string;
  fileUrl?: string;
  fileName?: string;
  mimeType?: string;
}

export interface TaskOutputItem {
  id: string;
  status: string;
  role: string;
  type: string;
  content: TaskOutputContent[];
}

export interface TaskDetail {
  id: string;
  object: string;
  created_at: number;
  updated_at: number;
  status: TaskStatus;
  error?: string;
  incomplete_details?: string;
  instructions?: string;
  metadata?: {
    task_title?: string;
    task_url?: string;
  };
  output?: TaskOutputItem[];
  credit_usage?: number;
}

function getApiKey(): string {
  const key = process.env.MANUS_API_KEY;
  if (!key) {
    throw new Error('MANUS_API_KEY environment variable is not set');
  }
  return key;
}

export async function createTask(request: CreateTaskRequest): Promise<CreateTaskResponse> {
  const response = await fetch(`${MANUS_API_BASE}/tasks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'API_KEY': getApiKey(),
    },
    body: JSON.stringify({
      prompt: request.prompt,
      agentProfile: request.agentProfile ?? 'manus-1.6',
      ...(request.taskMode && { taskMode: request.taskMode }),
      ...(request.hideInTaskList !== undefined && { hideInTaskList: request.hideInTaskList }),
      ...(request.createShareableLink !== undefined && { createShareableLink: request.createShareableLink }),
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Manus API createTask failed (${response.status}): ${text}`);
  }

  return response.json() as Promise<CreateTaskResponse>;
}

export async function getTask(taskId: string): Promise<TaskDetail> {
  const response = await fetch(`${MANUS_API_BASE}/tasks?query=${encodeURIComponent(taskId)}&limit=1`, {
    method: 'GET',
    headers: {
      'API_KEY': getApiKey(),
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Manus API getTask failed (${response.status}): ${text}`);
  }

  const body = await response.json() as { data: TaskDetail[] };
  const task = body.data?.find((t) => t.id === taskId);
  if (!task) {
    throw new Error(`Task ${taskId} not found`);
  }
  return task;
}

const POLL_INTERVAL_MS = 10_000;
const MAX_POLL_DURATION_MS = 30 * 60 * 1000; // 30 minutes

export async function pollTaskUntilDone(
  taskId: string,
  onStatusChange?: (task: TaskDetail) => void,
): Promise<TaskDetail> {
  const start = Date.now();
  let lastStatus: TaskStatus | undefined;

  while (Date.now() - start < MAX_POLL_DURATION_MS) {
    const task = await getTask(taskId);

    if (task.status !== lastStatus) {
      lastStatus = task.status;
      onStatusChange?.(task);
    }

    if (task.status === 'completed' || task.status === 'failed') {
      return task;
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new Error(`Task ${taskId} did not complete within ${MAX_POLL_DURATION_MS / 60_000} minutes`);
}
