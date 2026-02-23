import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
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
  profileActivityId?: string | null;
}

function getDataDir(): string {
  const dir = process.env.DATA_DIR ?? process.cwd();
  mkdirSync(dir, { recursive: true });
  return dir;
}

const PENDING_STORE_PATH = join(getDataDir(), '.pending-tasks.json');
const TASK_STORE_PATH = join(getDataDir(), '.tasks.json');

// In-memory task store mapping Manus task IDs to Linear issue context.
const taskStore = new Map<string, TaskRecord>();
const pendingTaskStore = new Map<string, PendingTaskRecord>();

function loadMapFromFile<T>(path: string): Map<string, T> {
  if (!existsSync(path)) return new Map();
  try {
    const raw = readFileSync(path, 'utf8');
    const entries: [string, T][] = JSON.parse(raw);
    return new Map(entries);
  } catch {
    console.error(`[taskStore] Failed to load ${path}; starting fresh`);
    return new Map();
  }
}

function persistMap<T>(map: Map<string, T>, path: string): void {
  try {
    writeFileSync(path, JSON.stringify(Array.from(map.entries())), 'utf8');
  } catch (err) {
    console.error(`[taskStore] Failed to persist ${path}:`, err);
  }
}

// Restore from disk on startup
function initStores(): void {
  const restoredPending = loadMapFromFile<PendingTaskRecord>(PENDING_STORE_PATH);
  for (const [k, v] of restoredPending) pendingTaskStore.set(k, v);
  if (restoredPending.size > 0) {
    console.log(`[taskStore] Restored ${restoredPending.size} pending task(s) from disk`);
  }

  const restoredTasks = loadMapFromFile<TaskRecord>(TASK_STORE_PATH);
  for (const [k, v] of restoredTasks) taskStore.set(k, v);
  if (restoredTasks.size > 0) {
    console.log(`[taskStore] Restored ${restoredTasks.size} task(s) from disk`);
  }
}

initStores();

export function storeTask(taskId: string, record: TaskRecord): void {
  taskStore.set(taskId, { ...record });
  persistMap(taskStore, TASK_STORE_PATH);
}

export function getTask(taskId: string): TaskRecord | undefined {
  return taskStore.get(taskId);
}

export function updateProgressCommentId(taskId: string, commentId: string): void {
  const record = taskStore.get(taskId);
  if (!record) return;
  taskStore.set(taskId, { ...record, progressCommentId: commentId });
  persistMap(taskStore, TASK_STORE_PATH);
}

export function updateQuestionCommentId(taskId: string, commentId: string): void {
  const record = taskStore.get(taskId);
  if (!record) return;
  taskStore.set(taskId, { ...record, questionCommentId: commentId });
  persistMap(taskStore, TASK_STORE_PATH);
}

export function consumeTask(taskId: string): TaskRecord | undefined {
  const record = taskStore.get(taskId);
  if (record) {
    taskStore.delete(taskId);
    persistMap(taskStore, TASK_STORE_PATH);
  }
  return record;
}

export function removeTask(taskId: string): void {
  taskStore.delete(taskId);
  persistMap(taskStore, TASK_STORE_PATH);
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
  persistMap(pendingTaskStore, PENDING_STORE_PATH);
}

export function getPendingTask(commentId: string): PendingTaskRecord | undefined {
  return pendingTaskStore.get(commentId);
}

export function findPendingTaskBySession(
  agentSessionId: string,
): { commentId: string; record: PendingTaskRecord } | undefined {
  for (const [commentId, record] of pendingTaskStore.entries()) {
    if (record.agentSessionId === agentSessionId) {
      return { commentId, record };
    }
  }
  return undefined;
}

export function findPendingTaskByIssue(
  issueId: string,
): { commentId: string; record: PendingTaskRecord } | undefined {
  for (const [commentId, record] of pendingTaskStore.entries()) {
    if (record.linearIssueId === issueId) {
      return { commentId, record };
    }
  }
  return undefined;
}

export function consumePendingTask(commentId: string): PendingTaskRecord | undefined {
  const record = pendingTaskStore.get(commentId);
  if (record) {
    pendingTaskStore.delete(commentId);
    persistMap(pendingTaskStore, PENDING_STORE_PATH);
  }
  return record;
}
