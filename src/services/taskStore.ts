import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import { join } from 'path';
import type { ManusAttachment } from './manusClient';
import { createLogger } from './logger';

const log = createLogger('taskStore');

export interface TaskRecord {
  linearIssueId: string;
  linearTeamId?: string;
  workspaceId: string;
  agentSessionId?: string;
  progressCommentId?: string;
  questionCommentId?: string;
  parentCommentId?: string;
}

export interface PlanStep {
  content: string;
  status: 'pending' | 'inProgress' | 'completed' | 'canceled';
  addedAt: number;
}

// Plan store: taskId -> array of plan steps
const planStore = new Map<string, PlanStep[]>();

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
const PLAN_STORE_PATH = join(getDataDir(), '.plans.json');

// In-memory task store mapping Manus task IDs to Linear issue context.
const taskStore = new Map<string, TaskRecord>();
const pendingTaskStore = new Map<string, PendingTaskRecord>();

// Simple mutex to prevent concurrent writes to the same file
const writeLocks = new Map<string, boolean>();

function loadMapFromFile<T>(path: string): Map<string, T> {
  if (!existsSync(path)) return new Map();
  try {
    const raw = readFileSync(path, 'utf8');
    const entries: [string, T][] = JSON.parse(raw);
    return new Map(entries);
  } catch (err) {
    log.error({ path, err }, 'Failed to load file; starting fresh');
    return new Map();
  }
}

/**
 * Atomically write data to a file by writing to a temp file first, then renaming.
 * This prevents corruption from partial writes if the process crashes mid-write.
 */
function atomicWrite(path: string, data: string): void {
  const tmpPath = `${path}.tmp`;
  try {
    writeFileSync(tmpPath, data, 'utf8');
    renameSync(tmpPath, path);
  } catch (err) {
    log.error({ path, err }, 'Failed to atomically write file');
    // Clean up temp file if it exists
    try {
      if (existsSync(tmpPath)) {
        writeFileSync(tmpPath, '', 'utf8'); // Truncate to mark as failed
      }
    } catch {
      // Ignore cleanup errors
    }
  }
}

function persistMap<T>(map: Map<string, T>, path: string): void {
  // Prevent concurrent writes to the same file
  if (writeLocks.get(path)) {
    log.warn({ path }, 'Skipping write - already in progress');
    return;
  }
  writeLocks.set(path, true);
  try {
    atomicWrite(path, JSON.stringify(Array.from(map.entries())));
  } finally {
    writeLocks.delete(path);
  }
}

// Restore from disk on startup
function initStores(): void {
  const restoredPending = loadMapFromFile<PendingTaskRecord>(PENDING_STORE_PATH);
  for (const [k, v] of restoredPending) pendingTaskStore.set(k, v);
  if (restoredPending.size > 0) {
    log.info({ count: restoredPending.size }, 'Restored pending task(s) from disk');
  }

  const restoredTasks = loadMapFromFile<TaskRecord>(TASK_STORE_PATH);
  for (const [k, v] of restoredTasks) taskStore.set(k, v);
  if (restoredTasks.size > 0) {
    log.info({ count: restoredTasks.size }, 'Restored task(s) from disk');
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

export function updateParentCommentId(taskId: string, commentId: string): void {
  const record = taskStore.get(taskId);
  if (!record) return;
  taskStore.set(taskId, { ...record, parentCommentId: commentId });
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

export function removeTasksByIssue(issueId: string): number {
  let removed = 0;
  for (const [taskId, record] of taskStore.entries()) {
    if (record.linearIssueId === issueId) {
      taskStore.delete(taskId);
      removed++;
    }
  }
  if (removed > 0) {
    persistMap(taskStore, TASK_STORE_PATH);
    log.info({ issueId, count: removed }, 'Cleaned up stale task record(s)');
  }
  return removed;
}

export function storePendingTask(commentId: string, record: PendingTaskRecord): void {
  pendingTaskStore.set(commentId, { ...record });
  persistMap(pendingTaskStore, PENDING_STORE_PATH);
}

export function getPendingTask(commentId: string): PendingTaskRecord | undefined {
  return pendingTaskStore.get(commentId);
}

export function findPendingTaskBySession(
  agentSessionId: string
): { commentId: string; record: PendingTaskRecord } | undefined {
  for (const [commentId, record] of pendingTaskStore.entries()) {
    if (record.agentSessionId === agentSessionId) {
      return { commentId, record };
    }
  }
  return undefined;
}

export function findPendingTaskByIssue(
  issueId: string
): { commentId: string; record: PendingTaskRecord } | undefined {
  for (const [commentId, record] of pendingTaskStore.entries()) {
    if (record.linearIssueId === issueId) {
      return { commentId, record };
    }
  }
  return undefined;
}

export function getAllTasks(): Array<[string, TaskRecord]> {
  return Array.from(taskStore.entries());
}

export function getAllPendingTasks(): Array<[string, PendingTaskRecord]> {
  return Array.from(pendingTaskStore.entries());
}

export function consumePendingTask(commentId: string): PendingTaskRecord | undefined {
  const record = pendingTaskStore.get(commentId);
  if (record) {
    pendingTaskStore.delete(commentId);
    persistMap(pendingTaskStore, PENDING_STORE_PATH);
  }
  return record;
}

// ─── Plan management ────────────────────────────────────────────────────────

function persistPlans(): void {
  if (writeLocks.get(PLAN_STORE_PATH)) {
    log.warn({ path: PLAN_STORE_PATH }, 'Skipping plan write - already in progress');
    return;
  }
  writeLocks.set(PLAN_STORE_PATH, true);
  try {
    atomicWrite(PLAN_STORE_PATH, JSON.stringify(Array.from(planStore.entries())));
  } finally {
    writeLocks.delete(PLAN_STORE_PATH);
  }
}

function loadPlans(): void {
  if (!existsSync(PLAN_STORE_PATH)) return;
  try {
    const raw = readFileSync(PLAN_STORE_PATH, 'utf8');
    const entries: [string, PlanStep[]][] = JSON.parse(raw);
    for (const [k, v] of entries) planStore.set(k, v);
    if (entries.length > 0) {
      log.info({ count: entries.length }, 'Restored plan(s) from disk');
    }
  } catch (err) {
    log.error({ err }, 'Failed to load plans; starting fresh');
  }
}

// Load plans on startup
loadPlans();

// Periodic cleanup of orphaned plans every 5 minutes
setInterval(
  () => {
    cleanupOrphanedPlans();
  },
  5 * 60 * 1000
);

/**
 * Get the current plan for a task.
 */
export function getPlan(taskId: string): PlanStep[] | undefined {
  return planStore.get(taskId);
}

/**
 * Add or update a plan step from a Manus progress event.
 * - If the step content is new, mark all previous steps as completed and add new as inProgress
 * - If the step already exists, keep its status
 * Returns the updated plan array.
 */
export function addPlanStep(taskId: string, stepContent: string): PlanStep[] {
  const existing = planStore.get(taskId) ?? [];
  const normalizedContent = stepContent.trim();

  // Check if this step already exists
  const existingIndex = existing.findIndex(
    (s) => s.content.trim().toLowerCase() === normalizedContent.toLowerCase()
  );

  if (existingIndex >= 0) {
    // Step already exists, don't duplicate
    return existing;
  }

  // Mark all previous steps as completed
  const updated = existing.map((s) => ({
    ...s,
    status: s.status === 'inProgress' ? 'completed' : s.status,
  })) as PlanStep[];

  // Add new step as inProgress
  updated.push({
    content: normalizedContent,
    status: 'inProgress',
    addedAt: Date.now(),
  });

  planStore.set(taskId, updated);
  persistPlans();
  return updated;
}

/**
 * Mark all steps in a plan as completed.
 * Used when task finishes.
 */
export function completeAllPlanSteps(taskId: string): PlanStep[] | undefined {
  const existing = planStore.get(taskId);
  if (!existing) return undefined;

  const updated = existing.map((s) => ({
    ...s,
    status: 'completed' as const,
  }));

  planStore.set(taskId, updated);
  persistPlans();
  return updated;
}

/**
 * Clear the plan for a task (e.g., when task is consumed).
 */
export function clearPlan(taskId: string): void {
  planStore.delete(taskId);
  persistPlans();
}

/**
 * Clear plans for tasks that no longer exist in taskStore.
 */
export function cleanupOrphanedPlans(): void {
  for (const taskId of planStore.keys()) {
    if (!taskStore.has(taskId)) {
      planStore.delete(taskId);
    }
  }
  persistPlans();
}
