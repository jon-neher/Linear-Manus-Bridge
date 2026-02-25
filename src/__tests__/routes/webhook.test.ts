import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';

describe('Manus webhook endpoint', () => {
  let app: Express.Application;
  let tempDir: string;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'manus-webhook-test-'));
    process.env.DATA_DIR = tempDir;
    process.env.PORT = '0';
    vi.resetModules();
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.resetModules();
  });

  describe('task_created', () => {
    it('includes PR URL in externalUrls when provided', async () => {
      vi.doMock('../../services/manusWebhookVerifier', () => ({
        verifyManusWebhookSignature: vi.fn().mockResolvedValue(true),
      }));
      vi.doMock('../../services/taskStore', () => ({
        getTask: vi.fn().mockReturnValue({
          linearIssueId: 'issue-1',
          workspaceId: 'org-1',
          agentSessionId: 'session-1',
          prompt: 'test',
          attachments: [],
        }),
        storeTask: vi.fn(),
        updateProgressCommentId: vi.fn(),
        updateParentCommentId: vi.fn(),
        updateQuestionCommentId: vi.fn(),
        consumeTask: vi.fn(),
      }));
      vi.doMock('../../services/linearAuth', () => ({
        getValidToken: vi.fn().mockResolvedValue('mock-token'),
      }));
      vi.doMock('../../services/linearAgentSession', () => ({
        createAgentActivity: vi.fn().mockResolvedValue('activity-1'),
        updateAgentSession: vi.fn().mockResolvedValue(undefined),
      }));
      vi.doMock('../../services/linearClient', () => ({
        postComment: vi.fn().mockResolvedValue('comment-1'),
        updateComment: vi.fn().mockResolvedValue(undefined),
        findStateIdByName: vi.fn(),
        updateIssueState: vi.fn().mockResolvedValue(undefined),
      }));

      app = (await import('../../index')).default;

      const payload = {
        event_type: 'task_created',
        task_id: 'manus-123',
        task_detail: {
          task_id: 'manus-123',
          task_url: 'https://manus.ai/task/123',
          pull_request_url: 'https://github.com/owner/repo/pull/456',
          task_title: 'Implement feature',
        },
        metadata: {
          linear_issue_id: 'issue-1',
          workspace_id: 'org-1',
        },
      };

      const res = await request(app)
        .post('/webhook/manus')
        .set('Content-Type', 'application/json')
        .send(payload);

      expect(res.status).toBe(200);

      const { updateAgentSession } = await import('../../services/linearAgentSession');
      expect(updateAgentSession).toHaveBeenCalledWith(
        'session-1',
        expect.objectContaining({
          externalUrls: expect.arrayContaining([
            { label: 'View in Manus', url: 'https://manus.ai/task/123' },
            { label: 'View Pull Request', url: 'https://github.com/owner/repo/pull/456' },
          ]),
        }),
        'mock-token',
      );
    });

    it('includes only task URL in externalUrls when no PR URL', async () => {
      vi.doMock('../../services/manusWebhookVerifier', () => ({
        verifyManusWebhookSignature: vi.fn().mockResolvedValue(true),
      }));
      vi.doMock('../../services/taskStore', () => ({
        getTask: vi.fn().mockReturnValue({
          linearIssueId: 'issue-1',
          workspaceId: 'org-1',
          agentSessionId: 'session-1',
          prompt: 'test',
          attachments: [],
        }),
        storeTask: vi.fn(),
        updateProgressCommentId: vi.fn(),
        updateParentCommentId: vi.fn(),
        updateQuestionCommentId: vi.fn(),
        consumeTask: vi.fn(),
      }));
      vi.doMock('../../services/linearAuth', () => ({
        getValidToken: vi.fn().mockResolvedValue('mock-token'),
      }));
      vi.doMock('../../services/linearAgentSession', () => ({
        createAgentActivity: vi.fn().mockResolvedValue('activity-1'),
        updateAgentSession: vi.fn().mockResolvedValue(undefined),
      }));
      vi.doMock('../../services/linearClient', () => ({
        postComment: vi.fn().mockResolvedValue('comment-1'),
        updateComment: vi.fn().mockResolvedValue(undefined),
        findStateIdByName: vi.fn(),
        updateIssueState: vi.fn().mockResolvedValue(undefined),
      }));

      app = (await import('../../index')).default;

      const payload = {
        event_type: 'task_created',
        task_id: 'manus-123',
        task_detail: {
          task_id: 'manus-123',
          task_url: 'https://manus.ai/task/123',
          task_title: 'Implement feature',
        },
        metadata: {
          linear_issue_id: 'issue-1',
          workspace_id: 'org-1',
        },
      };

      const res = await request(app)
        .post('/webhook/manus')
        .set('Content-Type', 'application/json')
        .send(payload);

      expect(res.status).toBe(200);

      const { updateAgentSession } = await import('../../services/linearAgentSession');
      expect(updateAgentSession).toHaveBeenCalledWith(
        'session-1',
        expect.objectContaining({
          externalUrls: [{ label: 'View in Manus', url: 'https://manus.ai/task/123' }],
        }),
        'mock-token',
      );
    });
  });

  describe('task_stopped', () => {
    it('includes PR link in response when finish with PR URL', async () => {
      vi.doMock('../../services/manusWebhookVerifier', () => ({
        verifyManusWebhookSignature: vi.fn().mockResolvedValue(true),
      }));
      vi.doMock('../../services/taskStore', () => ({
        getTask: vi.fn().mockReturnValue({
          linearIssueId: 'issue-1',
          linearTeamId: 'team-1',
          workspaceId: 'org-1',
          agentSessionId: 'session-1',
          prompt: 'test',
          attachments: [],
        }),
        consumeTask: vi.fn(),
        storeTask: vi.fn(),
        updateProgressCommentId: vi.fn(),
        updateParentCommentId: vi.fn(),
        updateQuestionCommentId: vi.fn(),
      }));
      vi.doMock('../../services/linearAuth', () => ({
        getValidToken: vi.fn().mockResolvedValue('mock-token'),
      }));
      vi.doMock('../../services/linearAgentSession', () => ({
        createAgentActivity: vi.fn().mockResolvedValue('activity-response'),
        updateAgentSession: vi.fn().mockResolvedValue(undefined),
      }));
      vi.doMock('../../services/linearClient', () => ({
        postComment: vi.fn().mockResolvedValue('comment-1'),
        updateComment: vi.fn().mockResolvedValue(undefined),
        findStateIdByName: vi.fn().mockResolvedValue('state-done'),
        updateIssueState: vi.fn().mockResolvedValue(undefined),
      }));

      app = (await import('../../index')).default;

      const payload = {
        event_type: 'task_stopped',
        task_id: 'manus-123',
        task_detail: {
          task_id: 'manus-123',
          task_url: 'https://manus.ai/task/123',
          pull_request_url: 'https://github.com/owner/repo/pull/456',
          stop_reason: 'finish',
          message: 'Task completed successfully',
        },
        metadata: {
          linear_issue_id: 'issue-1',
          workspace_id: 'org-1',
        },
      };

      const res = await request(app)
        .post('/webhook/manus')
        .set('Content-Type', 'application/json')
        .send(payload);

      expect(res.status).toBe(200);

      const { createAgentActivity } = await import('../../services/linearAgentSession');
      expect(createAgentActivity).toHaveBeenCalledWith(
        'session-1',
        expect.objectContaining({
          type: 'response',
          body: expect.stringContaining('github.com/owner/repo/pull/456'),
        }),
        'mock-token',
      );
    });
  });
});
