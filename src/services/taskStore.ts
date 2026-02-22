export interface TaskRecord {
  linearIssueId: string;
  linearTeamId?: string;
  workspaceId: string;
  progressCommentId?: string;
}

// In-memory task store mapping Manus task IDs to Linear issue context.
// Replace with a persistent store (e.g. Redis/database) in production.
const taskStore = new Map<string, TaskRecord>();

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

export function consumeTask(taskId: string): TaskRecord | undefined {
  const record = taskStore.get(taskId);
  if (record) taskStore.delete(taskId);
  return record;
}
