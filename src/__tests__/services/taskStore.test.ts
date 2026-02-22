import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { TaskRecord } from '../../services/taskStore';

describe('taskStore', () => {
  let storeTask: typeof import('../../services/taskStore').storeTask;
  let getTask: typeof import('../../services/taskStore').getTask;
  let updateProgressCommentId: typeof import('../../services/taskStore').updateProgressCommentId;
  let updateQuestionCommentId: typeof import('../../services/taskStore').updateQuestionCommentId;
  let consumeTask: typeof import('../../services/taskStore').consumeTask;
  let findTaskByQuestionCommentId: typeof import('../../services/taskStore').findTaskByQuestionCommentId;
  let storePendingTask: typeof import('../../services/taskStore').storePendingTask;
  let getPendingTask: typeof import('../../services/taskStore').getPendingTask;
  let consumePendingTask: typeof import('../../services/taskStore').consumePendingTask;
  let removeTask: typeof import('../../services/taskStore').removeTask;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../../services/taskStore');
    storeTask = mod.storeTask;
    getTask = mod.getTask;
    updateProgressCommentId = mod.updateProgressCommentId;
    updateQuestionCommentId = mod.updateQuestionCommentId;
    consumeTask = mod.consumeTask;
    findTaskByQuestionCommentId = mod.findTaskByQuestionCommentId;
    storePendingTask = mod.storePendingTask;
    getPendingTask = mod.getPendingTask;
    consumePendingTask = mod.consumePendingTask;
    removeTask = mod.removeTask;
  });

  const record: TaskRecord = {
    linearIssueId: 'issue-1',
    linearTeamId: 'team-1',
    workspaceId: 'ws-1',
  };

  describe('storeTask', () => {
    it('stores a defensive copy of the record', () => {
      const input = { ...record };
      storeTask('task-1', input);
      input.linearIssueId = 'mutated';

      const stored = getTask('task-1');
      expect(stored?.linearIssueId).toBe('issue-1');
    });
  });

  describe('getTask', () => {
    it('returns the stored record', () => {
      storeTask('task-1', record);
      expect(getTask('task-1')).toEqual(record);
    });

    it('returns undefined for unknown taskId', () => {
      expect(getTask('unknown')).toBeUndefined();
    });
  });

  describe('updateProgressCommentId', () => {
    it('updates progressCommentId on an existing record', () => {
      storeTask('task-1', record);
      updateProgressCommentId('task-1', 'comment-99');
      expect(getTask('task-1')?.progressCommentId).toBe('comment-99');
    });

    it('is a no-op for an unknown taskId', () => {
      updateProgressCommentId('unknown', 'comment-99');
      expect(getTask('unknown')).toBeUndefined();
    });
  });

  describe('consumeTask', () => {
    it('returns the record and removes it from the store', () => {
      storeTask('task-1', record);
      const consumed = consumeTask('task-1');
      expect(consumed).toEqual(record);
      expect(getTask('task-1')).toBeUndefined();
    });

    it('returns undefined for an unknown taskId', () => {
      expect(consumeTask('unknown')).toBeUndefined();
    });
  });

  describe('updateQuestionCommentId', () => {
    it('updates questionCommentId on an existing record', () => {
      storeTask('task-1', record);
      updateQuestionCommentId('task-1', 'comment-42');
      expect(getTask('task-1')?.questionCommentId).toBe('comment-42');
    });
  });

  describe('findTaskByQuestionCommentId', () => {
    it('finds a task by question comment id', () => {
      storeTask('task-1', record);
      updateQuestionCommentId('task-1', 'comment-42');
      expect(findTaskByQuestionCommentId('comment-42')).toBe('task-1');
    });
  });

  describe('pending task store', () => {
    it('stores and consumes pending tasks by comment id', () => {
      const pending = {
        linearIssueId: 'issue-1',
        workspaceId: 'ws-1',
        prompt: 'Prompt',
        attachments: [],
      };
      storePendingTask('comment-1', pending);
      expect(getPendingTask('comment-1')).toEqual(pending);
      expect(consumePendingTask('comment-1')).toEqual(pending);
      expect(getPendingTask('comment-1')).toBeUndefined();
    });
  });

  describe('removeTask', () => {
    it('removes a task without returning it', () => {
      storeTask('task-1', record);
      removeTask('task-1');
      expect(getTask('task-1')).toBeUndefined();
    });
  });

});
