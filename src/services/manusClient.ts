import { MANUS_API_BASE_URL } from './constants';

interface ManusTaskResponse {
  task_id: string;
  task_title?: string;
  task_url?: string;
  share_url?: string;
}

interface ManusFileResponse {
  id: string;
  object?: string;
  filename?: string;
  status?: string;
  upload_url: string;
  upload_expires_at?: string;
  created_at?: string;
}

export interface ManusTaskOptions {
  agentProfile?: string;
  taskMode?: string;
  taskId?: string;
  interactiveMode?: boolean;
  attachments?: ManusAttachment[];
  connectors?: string[];
  repositorySuggestions?: Array<{ hostname: string; repositoryFullName: string; confidence: number }>;
}

export type ManusAttachment =
  | { url: string }
  | { file_id: string }
  | { data: string; filename?: string; mime_type?: string };

interface ManusCreateResult {
  taskId: string;
  taskUrl?: string;
  usedProfile: string;
  fallbackToLite: boolean;
}

async function requestCreateTask(
  prompt: string,
  options: ManusTaskOptions,
  agentProfile: string,
): Promise<{ ok: true; data: ManusTaskResponse } | { ok: false; status: number; text: string }>
{
  const apiKey = process.env.MANUS_API_KEY;
  if (!apiKey) {
    throw new Error('MANUS_API_KEY is not configured');
  }

  console.log('[manusClient] requestCreateTask', {
    agentProfile,
    promptLength: prompt.length,
    taskId: options.taskId ?? '(new)',
    taskMode: options.taskMode ?? process.env.MANUS_TASK_MODE ?? 'agent',
    interactiveMode: options.interactiveMode ?? true,
    attachmentCount: options.attachments?.length ?? 0,
    connectorCount: options.connectors?.length ?? 0,
  });

  const response = await fetch(`${MANUS_API_BASE_URL}/v1/tasks`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      API_KEY: apiKey,
    },
    body: JSON.stringify({
      prompt,
      taskId: options.taskId,
      agentProfile,
      taskMode: options.taskMode ?? process.env.MANUS_TASK_MODE ?? 'agent',
      interactiveMode: options.interactiveMode ?? true,
      attachments: options.attachments,
      connectors: options.connectors,
      repositorySuggestions: options.repositorySuggestions,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    console.error('[manusClient] requestCreateTask failed', { status: response.status, text: text.slice(0, 500) });
    return { ok: false, status: response.status, text };
  }

  const data = (await response.json()) as ManusTaskResponse;
  console.log('[manusClient] requestCreateTask success', {
    taskId: data.task_id,
    taskUrl: data.task_url ?? '(none)',
  });
  return { ok: true, data };
}

function isCreditError(status: number, text: string): boolean {
  const message = text.toLowerCase();
  return status === 402 || message.includes('credit') || message.includes('insufficient');
}

export async function createTaskWithFallback(
  prompt: string,
  options: ManusTaskOptions = {},
): Promise<ManusCreateResult> {
  const preferredProfile =
    options.agentProfile ?? process.env.MANUS_AGENT_PROFILE ?? 'manus-1.6';

  const primary = await requestCreateTask(prompt, options, preferredProfile);
  if (primary.ok) {
    if (!primary.data.task_id) {
      throw new Error('Manus response missing task_id');
    }
    return {
      taskId: primary.data.task_id,
      taskUrl: primary.data.task_url,
      usedProfile: preferredProfile,
      fallbackToLite: false,
    };
  }

  if (preferredProfile !== 'manus-1.6-lite' && isCreditError(primary.status, primary.text)) {
    const fallback = await requestCreateTask(prompt, options, 'manus-1.6-lite');
    if (fallback.ok) {
      if (!fallback.data.task_id) {
        throw new Error('Manus response missing task_id');
      }
      return {
        taskId: fallback.data.task_id,
        taskUrl: fallback.data.task_url,
        usedProfile: 'manus-1.6-lite',
        fallbackToLite: true,
      };
    }
    throw new Error(`Manus task creation failed (${fallback.status}): ${fallback.text}`);
  }

  throw new Error(`Manus task creation failed (${primary.status}): ${primary.text}`);
}

export async function replyToTask(
  taskId: string,
  message: string,
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
      taskId,
      prompt: message,
      agentProfile: process.env.MANUS_AGENT_PROFILE ?? 'manus-1.6',
      taskMode: process.env.MANUS_TASK_MODE ?? 'agent',
      interactiveMode: true,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Manus reply failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as ManusTaskResponse;
  return { taskId: data.task_id, taskUrl: data.task_url };
}

export async function createFileRecord(filename: string): Promise<ManusFileResponse> {
  const apiKey = process.env.MANUS_API_KEY;
  if (!apiKey) {
    throw new Error('MANUS_API_KEY is not configured');
  }

  const response = await fetch(`${MANUS_API_BASE_URL}/v1/files`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      API_KEY: apiKey,
    },
    body: JSON.stringify({ filename }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Manus file create failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as ManusFileResponse;
  if (!data.id || !data.upload_url) {
    throw new Error('Manus file response missing id or upload_url');
  }
  return data;
}

export async function uploadFileToManus(
  uploadUrl: string,
  data: Buffer,
  contentType?: string,
): Promise<void> {
  const response = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': contentType ?? 'application/octet-stream',
    },
    body: data,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Manus file upload failed (${response.status}): ${text}`);
  }
}
