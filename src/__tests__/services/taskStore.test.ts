import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { TaskRecord } from '../../services/taskStore';

describe('taskStore', () => {
  let storeTask: typeof import('../../services/taskStore').storeTask;
  let getTask: typeof import('../../services/taskStore').getTask;
  let updateProgressCommentId: typeof import('../../services/taskStore').updateProgressCommentId;
  let consumeTask: typeof import('../../services/taskStore').consumeTask;
  let findTaskBySession: typeof import('../../services/taskStore').findTaskBySession;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../../services/taskStore');
    storeTask = mod.storeTask;
    getTask = mod.getTask;
    updateProgressCommentId = mod.updateProgressCommentId;
    consumeTask = mod.consumeTask;
    findTaskBySession = mod.findTaskBySession;
  });

  const record: TaskRecord = {
    linearIssueId: 'issue-1',
    linearTeamId: 'team-1',
    workspaceId: 'ws-1',
    agentSessionId: 'session-1',
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

  describe('findTaskBySession', () => {
    it('returns the taskId matching the agentSessionId', () => {
      storeTask('task-1', record);
      storeTask('task-2', { ...record, agentSessionId: 'session-2' });
      expect(findTaskBySession('session-2')).toBe('task-2');
    });

    it('returns undefined when no session matches', () => {
      storeTask('task-1', record);
      expect(findTaskBySession('no-match')).toBeUndefined();
    });
  });
});
