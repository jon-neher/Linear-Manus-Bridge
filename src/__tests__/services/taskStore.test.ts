import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { TaskRecord } from '../../services/taskStore';

describe('taskStore', () => {
  let tempDir: string;
  let storeTask: typeof import('../../services/taskStore').storeTask;
  let getTask: typeof import('../../services/taskStore').getTask;
  let updateProgressCommentId: typeof import('../../services/taskStore').updateProgressCommentId;
  let updateQuestionCommentId: typeof import('../../services/taskStore').updateQuestionCommentId;
  let consumeTask: typeof import('../../services/taskStore').consumeTask;
  let findTaskByQuestionCommentId: typeof import('../../services/taskStore').findTaskByQuestionCommentId;
  let storePendingTask: typeof import('../../services/taskStore').storePendingTask;
  let getPendingTask: typeof import('../../services/taskStore').getPendingTask;
  let consumePendingTask: typeof import('../../services/taskStore').consumePendingTask;
  let findPendingTaskBySession: typeof import('../../services/taskStore').findPendingTaskBySession;
  let findPendingTaskByIssue: typeof import('../../services/taskStore').findPendingTaskByIssue;
  let removeTask: typeof import('../../services/taskStore').removeTask;
  let findTaskBySession: typeof import('../../services/taskStore').findTaskBySession;
  let getPlan: typeof import('../../services/taskStore').getPlan;
  let addPlanStep: typeof import('../../services/taskStore').addPlanStep;
  let completeAllPlanSteps: typeof import('../../services/taskStore').completeAllPlanSteps;
  let clearPlan: typeof import('../../services/taskStore').clearPlan;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'task-store-test-'));
    process.env.DATA_DIR = tempDir;
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
    findPendingTaskBySession = mod.findPendingTaskBySession;
    findPendingTaskByIssue = mod.findPendingTaskByIssue;
    removeTask = mod.removeTask;
    findTaskBySession = mod.findTaskBySession;
    getPlan = mod.getPlan;
    addPlanStep = mod.addPlanStep;
    completeAllPlanSteps = mod.completeAllPlanSteps;
    clearPlan = mod.clearPlan;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
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
        connectors: ['connector-1'],
        profileActivityId: 'activity-1',
      };
      storePendingTask('comment-1', pending);
      expect(getPendingTask('comment-1')).toEqual(pending);
      expect(consumePendingTask('comment-1')).toEqual(pending);
      expect(getPendingTask('comment-1')).toBeUndefined();
    });

    it('finds pending tasks by agent session id', () => {
      const pending = {
        linearIssueId: 'issue-1',
        workspaceId: 'ws-1',
        agentSessionId: 'session-1',
        prompt: 'Prompt',
        attachments: [],
      };
      storePendingTask('comment-1', pending);
      const match = findPendingTaskBySession('session-1');
      expect(match).toEqual({ commentId: 'comment-1', record: pending });
    });

    it('finds pending tasks by issue id', () => {
      const pending = {
        linearIssueId: 'issue-1',
        workspaceId: 'ws-1',
        prompt: 'Prompt',
        attachments: [],
      };
      storePendingTask('issue-1', pending);
      const match = findPendingTaskByIssue('issue-1');
      expect(match).toEqual({ commentId: 'issue-1', record: pending });
    });
  });

  describe('removeTask', () => {
    it('removes a task without returning it', () => {
      storeTask('task-1', record);
      removeTask('task-1');
      expect(getTask('task-1')).toBeUndefined();
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

  describe('plan management', () => {
    describe('getPlan', () => {
      it('returns undefined when no plan exists', () => {
        expect(getPlan('task-1')).toBeUndefined();
      });

      it('returns plan after steps are added', () => {
        addPlanStep('task-1', 'Step 1');
        const plan = getPlan('task-1');
        expect(plan).toHaveLength(1);
        expect(plan?.[0].content).toBe('Step 1');
      });
    });

    describe('addPlanStep', () => {
      it('creates a new plan with first step as inProgress', () => {
        const plan = addPlanStep('task-1', 'First step');
        expect(plan).toHaveLength(1);
        expect(plan[0]).toEqual({
          content: 'First step',
          status: 'inProgress',
          addedAt: expect.any(Number),
        });
      });

      it('marks previous step as completed when adding new step', () => {
        addPlanStep('task-1', 'Step 1');
        const plan = addPlanStep('task-1', 'Step 2');
        expect(plan).toHaveLength(2);
        expect(plan[0].status).toBe('completed');
        expect(plan[1].status).toBe('inProgress');
      });

      it('does not duplicate identical step content', () => {
        addPlanStep('task-1', 'Same step');
        const plan = addPlanStep('task-1', 'Same step');
        expect(plan).toHaveLength(1);
      });

      it('ignores case when checking for duplicates', () => {
        addPlanStep('task-1', 'Do something');
        const plan = addPlanStep('task-1', 'DO SOMETHING');
        expect(plan).toHaveLength(1);
      });

      it('trims whitespace from step content', () => {
        const plan = addPlanStep('task-1', '  Trimmed step  ');
        expect(plan[0].content).toBe('Trimmed step');
      });
    });

    describe('completeAllPlanSteps', () => {
      it('marks all steps as completed', () => {
        addPlanStep('task-1', 'Step 1');
        addPlanStep('task-1', 'Step 2');
        const plan = completeAllPlanSteps('task-1');
        expect(plan).toHaveLength(2);
        expect(plan?.every((s) => s.status === 'completed')).toBe(true);
      });

      it('returns undefined when no plan exists', () => {
        expect(completeAllPlanSteps('no-plan')).toBeUndefined();
      });
    });

    describe('clearPlan', () => {
      it('removes plan for a task', () => {
        addPlanStep('task-1', 'Step 1');
        expect(getPlan('task-1')).toHaveLength(1);
        clearPlan('task-1');
        expect(getPlan('task-1')).toBeUndefined();
      });
    });
  });
});
