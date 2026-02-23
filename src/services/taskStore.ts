import type { ManusAttachment } from './manusClient';

export interface TaskRecord {
  linearIssueId: string;
  linearTeamId?: string;
  workspaceId: string;
  agentSessionId?: string;
  progressCommentId?: string;
  questionCommentId?: string;
}

export interface PendingTaskRecord {
  linearIssueId: string;
  linearTeamId?: string;
  workspaceId: string;
  agentSessionId?: string;
  prompt: string;
  attachments: ManusAttachment[];
  connectors?: string[];
}

// In-memory task store mapping Manus task IDs to Linear issue context.
// Replace with a persistent store (e.g. Redis/database) in production.
const taskStore = new Map<string, TaskRecord>();
const pendingTaskStore = new Map<string, PendingTaskRecord>();

export function storeTask(taskId: string, record: TaskRecord): void {
  taskStore.set(taskId, { ...record });
}

export function getTask(taskId: string): TaskRecord | undefined {
  return taskStore.get(taskId);
}

export function updateProgressCommentId(taskId: string, commentId: string): void {
  const record = taskStore.get(taskId);
  if (!record) return;
  taskStore.set(taskId, { ...record, progressCommentId: commentId });
}

export function updateQuestionCommentId(taskId: string, commentId: string): void {
  const record = taskStore.get(taskId);
  if (!record) return;
  taskStore.set(taskId, { ...record, questionCommentId: commentId });
}

export function consumeTask(taskId: string): TaskRecord | undefined {
  const record = taskStore.get(taskId);
  if (record) taskStore.delete(taskId);
  return record;
}

export function removeTask(taskId: string): void {
  taskStore.delete(taskId);
}

export function findTaskBySession(agentSessionId: string): string | undefined {
  for (const [taskId, record] of taskStore.entries()) {
    if (record.agentSessionId === agentSessionId) {
      return taskId;
    }
  }
  return undefined;
}

export function findTaskByQuestionCommentId(commentId: string): string | undefined {
  for (const [taskId, record] of taskStore.entries()) {
    if (record.questionCommentId === commentId) {
      return taskId;
    }
  }
  return undefined;
}

export function storePendingTask(commentId: string, record: PendingTaskRecord): void {
  pendingTaskStore.set(commentId, { ...record });
}

export function getPendingTask(commentId: string): PendingTaskRecord | undefined {
  return pendingTaskStore.get(commentId);
}

export function consumePendingTask(commentId: string): PendingTaskRecord | undefined {
  const record = pendingTaskStore.get(commentId);
  if (record) pendingTaskStore.delete(commentId);
  return record;
}
