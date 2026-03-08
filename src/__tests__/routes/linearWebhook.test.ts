import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHmac } from 'crypto';
import request from 'supertest';

vi.mock('../../services/linearAuth', () => ({
  getValidToken: vi.fn(),
}));
vi.mock('../../services/linearClient', () => ({
  getIssueDetails: vi.fn(),
  findStateIdByName: vi.fn(),
  updateIssueState: vi.fn(),
  postComment: vi.fn(),
}));
vi.mock('../../services/manusClient', () => ({
  createTaskWithFallback: vi.fn(),
  replyToTask: vi.fn(),
}));
vi.mock('../../services/manusAttachments', () => ({
  buildManusAttachments: vi.fn(),
}));
vi.mock('../../services/linearAgentSession', () => ({
  createAgentActivity: vi.fn().mockResolvedValue(null),
  updateAgentSession: vi.fn().mockResolvedValue(undefined),
  emitAuthElicitation: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../services/taskStore', () => ({
  storeTask: vi.fn(),
  getTask: vi.fn(),
  storePendingTask: vi.fn(),
  getPendingTask: vi.fn(),
  consumePendingTask: vi.fn(),
  findTaskByQuestionCommentId: vi.fn(),
  findPendingTaskByIssue: vi.fn(),
  findPendingTaskBySession: vi.fn(),
  findTaskBySession: vi.fn(),
  removeTasksByIssue: vi.fn().mockReturnValue(0),
}));

function signBody(body: object): { rawBody: string; signature: string } {
  const raw = JSON.stringify(body);
  const sig = createHmac('sha256', process.env.LINEAR_WEBHOOK_SECRET!)
    .update(Buffer.from(raw))
    .digest('hex');
  return { rawBody: raw, signature: sig };
}

describe('Linear webhook endpoint', () => {
  let app: Express.Application;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'webhook-test-'));
    process.env.DATA_DIR = tmpDir;
    process.env.PORT = '0';
    vi.resetModules();

    const { getValidToken } = await import('../../services/linearAuth');
    const { getIssueDetails } = await import('../../services/linearClient');
    const { postComment } = await import('../../services/linearClient');
    const { buildManusAttachments } = await import('../../services/manusAttachments');

    (getValidToken as ReturnType<typeof vi.fn>).mockResolvedValue('mock-token');
    (getIssueDetails as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'issue-1',
      title: 'Test',
      description: 'Desc',
      teamId: 'team-1',
      teamName: null,
      projectName: null,
      projectIdentifier: null,
      comments: [],
    });
    (postComment as ReturnType<typeof vi.fn>).mockResolvedValue('comment-1');
    (buildManusAttachments as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const mod = await import('../../index');
    app = mod.default;
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects invalid signature with 401', async () => {
    const body = JSON.stringify({ type: 'Issue', action: 'create' });
    const res = await request(app)
      .post('/linear/webhook')
      .set('Content-Type', 'application/json')
      .set('linear-signature', 'invalidsignature')
      .send(body);

    expect(res.status).toBe(401);
  });

  it('handles Comment events without parentId as ignored', async () => {
    const payload = { type: 'Comment', action: 'create' };
    const { rawBody, signature } = signBody(payload);

    const res = await request(app)
      .post('/linear/webhook')
      .set('Content-Type', 'application/json')
      .set('linear-signature', signature)
      .send(rawBody);

    expect(res.status).toBe(200);
  });

  it('AgentSessionEvent created: returns awaitingProfile', async () => {
    const { getValidToken } = await import('../../services/linearAuth');
    const { getIssueDetails, postComment } = await import('../../services/linearClient');
    const { buildManusAttachments } = await import('../../services/manusAttachments');
    const { storePendingTask } = await import('../../services/taskStore');
    const { createAgentActivity } = await import('../../services/linearAgentSession');

    (getValidToken as ReturnType<typeof vi.fn>).mockResolvedValue('mock-token');
    (getIssueDetails as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'issue-1',
      title: 'Test',
      description: 'Desc',
      teamId: 'team-1',
      teamName: null,
      projectName: null,
      projectIdentifier: null,
      comments: [],
    });
    (postComment as ReturnType<typeof vi.fn>).mockResolvedValue('comment-1');
    (buildManusAttachments as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (createAgentActivity as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('activity-1')
      .mockResolvedValueOnce(null);

    const payload = {
      type: 'AgentSessionEvent',
      action: 'created',
      organizationId: 'org-1',
      agentSession: {
        id: 'session-1',
        issue: { id: 'issue-1', title: 'Test' },
      },
    };
    const { rawBody, signature } = signBody(payload);

    const res = await request(app)
      .post('/linear/webhook')
      .set('Content-Type', 'application/json')
      .set('linear-signature', signature)
      .send(rawBody);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, awaitingProfile: true });
    expect(storePendingTask).toHaveBeenCalledWith(
      'issue-1',
      expect.objectContaining({
        connectors: ['bbb0df76-66bd-4a24-ae4f-2aac4750d90b'],
        profileActivityId: 'activity-1',
      })
    );
    expect(createAgentActivity).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ type: 'thought' }),
      'mock-token'
    );
    expect(createAgentActivity).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ type: 'elicitation' }),
      'mock-token',
      expect.objectContaining({
        signal: 'select',
        signalMetadata: {
          options: [
            { label: 'Manus 1.6', value: 'manus-1.6' },
            { label: 'Manus 1.6 Lite', value: 'manus-1.6-lite' },
            { label: 'Manus 1.6 Max', value: 'manus-1.6-max' },
          ],
        },
      })
    );
    expect(postComment).not.toHaveBeenCalled();
  });

  it('AgentSessionEvent created: allows opt-out of GitHub connector', async () => {
    const { getValidToken } = await import('../../services/linearAuth');
    const { getIssueDetails, postComment } = await import('../../services/linearClient');
    const { buildManusAttachments } = await import('../../services/manusAttachments');
    const { storePendingTask } = await import('../../services/taskStore');
    const { createAgentActivity } = await import('../../services/linearAgentSession');

    (getValidToken as ReturnType<typeof vi.fn>).mockResolvedValue('mock-token');
    (getIssueDetails as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'issue-1',
      title: 'Test',
      description: 'Desc',
      teamId: 'team-1',
      teamName: null,
      projectName: null,
      projectIdentifier: null,
      comments: [{ body: '/manus connectors=none' }],
    });
    (postComment as ReturnType<typeof vi.fn>).mockResolvedValue('comment-1');
    (buildManusAttachments as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (createAgentActivity as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('activity-1');

    const payload = {
      type: 'AgentSessionEvent',
      action: 'created',
      organizationId: 'org-1',
      agentSession: {
        id: 'session-1',
        issue: { id: 'issue-1', title: 'Test' },
      },
    };
    const { rawBody, signature } = signBody(payload);

    const res = await request(app)
      .post('/linear/webhook')
      .set('Content-Type', 'application/json')
      .set('linear-signature', signature)
      .send(rawBody);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, awaitingProfile: true });
    expect(storePendingTask).toHaveBeenCalledWith(
      'issue-1',
      expect.objectContaining({
        connectors: [],
      })
    );
    expect(postComment).not.toHaveBeenCalled();
  });

  it('AgentSessionEvent missing issue id: returns 400', async () => {
    const payload = {
      type: 'AgentSessionEvent',
      action: 'created',
      organizationId: 'org-1',
      agentSession: {
        id: 'session-1',
      },
    };
    const { rawBody, signature } = signBody(payload);

    const res = await request(app)
      .post('/linear/webhook')
      .set('Content-Type', 'application/json')
      .set('linear-signature', signature)
      .send(rawBody);

    expect(res.status).toBe(400);
  });

  it('AgentSessionEvent missing organizationId: returns 422', async () => {
    const payload = {
      type: 'AgentSessionEvent',
      action: 'created',
      agentSession: {
        id: 'session-1',
        issue: { id: 'issue-1' },
      },
    };
    const { rawBody, signature } = signBody(payload);

    const res = await request(app)
      .post('/linear/webhook')
      .set('Content-Type', 'application/json')
      .set('linear-signature', signature)
      .send(rawBody);

    expect(res.status).toBe(422);
  });

  it('Comment reply with profile selection creates task', async () => {
    const { getValidToken } = await import('../../services/linearAuth');
    const { getPendingTask, findPendingTaskByIssue, consumePendingTask, storeTask } =
      await import('../../services/taskStore');
    const { createTaskWithFallback } = await import('../../services/manusClient');

    (getValidToken as ReturnType<typeof vi.fn>).mockResolvedValue('mock-token');
    (getPendingTask as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    (findPendingTaskByIssue as ReturnType<typeof vi.fn>).mockReturnValue({
      commentId: 'issue-1',
      record: {
        linearIssueId: 'issue-1',
        linearTeamId: 'team-1',
        workspaceId: 'org-1',
        agentSessionId: 'session-1',
        prompt: 'Prompt',
        attachments: [],
        connectors: ['github-connector'],
      },
    });
    (createTaskWithFallback as ReturnType<typeof vi.fn>).mockResolvedValue({
      taskId: 'task-1',
      taskUrl: 'https://manus.ai/task/1',
      usedProfile: 'manus-1.6',
      fallbackToLite: false,
    });

    const payload = {
      type: 'Comment',
      action: 'create',
      organizationId: 'org-1',
      data: {
        id: 'comment-2',
        body: 'manus-1.6',
        issueId: 'issue-1',
        parentId: 'comment-1',
      },
    };
    const { rawBody, signature } = signBody(payload);

    const res = await request(app)
      .post('/linear/webhook')
      .set('Content-Type', 'application/json')
      .set('linear-signature', signature)
      .send(rawBody);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, taskId: 'task-1' });
    expect(createTaskWithFallback).toHaveBeenCalledWith(
      'Prompt',
      expect.objectContaining({
        connectors: ['github-connector'],
      })
    );
    expect(consumePendingTask).toHaveBeenCalledWith('issue-1');
    expect(storeTask).toHaveBeenCalled();
  });

  it('Comment without parentId can select profile when pending by issue', async () => {
    const { getValidToken } = await import('../../services/linearAuth');
    const { findPendingTaskByIssue, consumePendingTask, storeTask } =
      await import('../../services/taskStore');
    const { createTaskWithFallback } = await import('../../services/manusClient');

    (getValidToken as ReturnType<typeof vi.fn>).mockResolvedValue('mock-token');
    (findPendingTaskByIssue as ReturnType<typeof vi.fn>).mockReturnValue({
      commentId: 'issue-1',
      record: {
        linearIssueId: 'issue-1',
        linearTeamId: 'team-1',
        workspaceId: 'org-1',
        agentSessionId: 'session-1',
        prompt: 'Prompt',
        attachments: [],
      },
    });
    (createTaskWithFallback as ReturnType<typeof vi.fn>).mockResolvedValue({
      taskId: 'task-2',
      taskUrl: 'https://manus.ai/task/2',
      usedProfile: 'manus-1.6',
      fallbackToLite: false,
    });

    const payload = {
      type: 'Comment',
      action: 'create',
      organizationId: 'org-1',
      data: {
        id: 'comment-3',
        body: 'manus-1.6',
        issueId: 'issue-1',
      },
    };
    const { rawBody, signature } = signBody(payload);

    const res = await request(app)
      .post('/linear/webhook')
      .set('Content-Type', 'application/json')
      .set('linear-signature', signature)
      .send(rawBody);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, taskId: 'task-2' });
    expect(consumePendingTask).toHaveBeenCalledWith('issue-1');
    expect(storeTask).toHaveBeenCalled();
  });

  it('Comment with invalid profile responds with guidance', async () => {
    const { getValidToken } = await import('../../services/linearAuth');
    const { findPendingTaskByIssue, consumePendingTask } = await import('../../services/taskStore');
    const { postComment } = await import('../../services/linearClient');
    const { createTaskWithFallback } = await import('../../services/manusClient');

    (getValidToken as ReturnType<typeof vi.fn>).mockResolvedValue('mock-token');
    (findPendingTaskByIssue as ReturnType<typeof vi.fn>).mockReturnValue({
      commentId: 'issue-1',
      record: {
        linearIssueId: 'issue-1',
        workspaceId: 'org-1',
        agentSessionId: 'session-1',
        prompt: 'Prompt',
        attachments: [],
      },
    });

    const payload = {
      type: 'Comment',
      action: 'create',
      organizationId: 'org-1',
      data: {
        id: 'comment-4',
        body: 'not-a-profile',
        issueId: 'issue-1',
      },
    };
    const { rawBody, signature } = signBody(payload);

    const res = await request(app)
      .post('/linear/webhook')
      .set('Content-Type', 'application/json')
      .set('linear-signature', signature)
      .send(rawBody);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, awaitingProfile: true });
    expect(consumePendingTask).not.toHaveBeenCalled();
    expect(createTaskWithFallback).not.toHaveBeenCalled();
    expect(postComment).toHaveBeenCalledWith(
      'issue-1',
      expect.stringContaining('manus-1.6'),
      'mock-token',
      undefined
    );
  });

  it('AgentSessionEvent prompted: profile selection creates task', async () => {
    const { getValidToken } = await import('../../services/linearAuth');
    const { createTaskWithFallback } = await import('../../services/manusClient');
    const { findPendingTaskBySession, consumePendingTask, storeTask } =
      await import('../../services/taskStore');

    (getValidToken as ReturnType<typeof vi.fn>).mockResolvedValue('mock-token');
    (findPendingTaskBySession as ReturnType<typeof vi.fn>).mockReturnValue({
      commentId: 'comment-1',
      record: {
        linearIssueId: 'issue-1',
        linearTeamId: 'team-1',
        workspaceId: 'org-1',
        agentSessionId: 'session-1',
        prompt: 'Prompt',
        attachments: [],
        connectors: ['github-connector'],
      },
    });
    (createTaskWithFallback as ReturnType<typeof vi.fn>).mockResolvedValue({
      taskId: 'task-1',
      taskUrl: 'https://manus.ai/task/1',
      usedProfile: 'manus-1.6',
      fallbackToLite: false,
    });

    const payload = {
      type: 'AgentSessionEvent',
      action: 'prompted',
      organizationId: 'org-1',
      agentSession: { id: 'session-1' },
      agentActivity: { id: 'activity-1', body: 'manus-1.6' },
    };
    const { rawBody, signature } = signBody(payload);

    const res = await request(app)
      .post('/linear/webhook')
      .set('Content-Type', 'application/json')
      .set('linear-signature', signature)
      .send(rawBody);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, taskId: 'task-1' });
    expect(consumePendingTask).toHaveBeenCalledWith('comment-1');
    expect(createTaskWithFallback).toHaveBeenCalledWith(
      'Prompt',
      expect.objectContaining({
        agentProfile: 'manus-1.6',
        connectors: ['github-connector'],
      })
    );
    expect(storeTask).toHaveBeenCalled();
  });

  it('AgentSessionEvent prompted: re-prompts when selection is invalid', async () => {
    const { getValidToken } = await import('../../services/linearAuth');
    const { createAgentActivity } = await import('../../services/linearAgentSession');
    const { findPendingTaskBySession, consumePendingTask } =
      await import('../../services/taskStore');
    const { createTaskWithFallback } = await import('../../services/manusClient');

    (getValidToken as ReturnType<typeof vi.fn>).mockResolvedValue('mock-token');
    (findPendingTaskBySession as ReturnType<typeof vi.fn>).mockReturnValue({
      commentId: 'comment-1',
      record: {
        linearIssueId: 'issue-1',
        workspaceId: 'org-1',
        agentSessionId: 'session-1',
        prompt: 'Prompt',
        attachments: [],
      },
    });
    (createAgentActivity as ReturnType<typeof vi.fn>).mockResolvedValue('activity-2');

    const payload = {
      type: 'AgentSessionEvent',
      action: 'prompted',
      organizationId: 'org-1',
      agentSession: { id: 'session-1' },
      agentActivity: { id: 'activity-1', body: 'not-a-profile' },
    };
    const { rawBody, signature } = signBody(payload);

    const res = await request(app)
      .post('/linear/webhook')
      .set('Content-Type', 'application/json')
      .set('linear-signature', signature)
      .send(rawBody);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, awaitingProfile: true });
    expect(consumePendingTask).not.toHaveBeenCalled();
    expect(createTaskWithFallback).not.toHaveBeenCalled();
    expect(createAgentActivity).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ type: 'response' }),
      'mock-token'
    );
  });

  it('AgentSessionEvent prompted: forwards reply to Manus', async () => {
    const { getValidToken } = await import('../../services/linearAuth');
    const { replyToTask } = await import('../../services/manusClient');
    const { findTaskBySession, findPendingTaskBySession } =
      await import('../../services/taskStore');

    (getValidToken as ReturnType<typeof vi.fn>).mockResolvedValue('mock-token');
    (findTaskBySession as ReturnType<typeof vi.fn>).mockReturnValue('manus-123');
    (findPendingTaskBySession as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    (replyToTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      taskId: 'manus-123',
      taskUrl: 'https://manus.ai/tasks/123',
    });

    const payload = {
      type: 'AgentSessionEvent',
      action: 'prompted',
      organizationId: 'org-1',
      agentSession: { id: 'session-1' },
      agentActivity: { id: 'activity-1', body: 'Please add tests' },
    };
    const { rawBody, signature } = signBody(payload);

    const res = await request(app)
      .post('/linear/webhook')
      .set('Content-Type', 'application/json')
      .set('linear-signature', signature)
      .send(rawBody);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, forwarded: true });
    expect(replyToTask).toHaveBeenCalledWith('manus-123', 'Please add tests');
  });

  it('AgentSessionEvent prompted: forwards stop when task is in progress', async () => {
    const { getValidToken } = await import('../../services/linearAuth');
    const { replyToTask } = await import('../../services/manusClient');
    const { findTaskBySession, findPendingTaskBySession } =
      await import('../../services/taskStore');
    const { createAgentActivity } = await import('../../services/linearAgentSession');

    (getValidToken as ReturnType<typeof vi.fn>).mockResolvedValue('mock-token');
    (findTaskBySession as ReturnType<typeof vi.fn>).mockReturnValue('manus-123');
    (findPendingTaskBySession as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    (replyToTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      taskId: 'manus-123',
      taskUrl: 'https://manus.ai/tasks/123',
    });

    const payload = {
      type: 'AgentSessionEvent',
      action: 'prompted',
      organizationId: 'org-1',
      agentSession: { id: 'session-1' },
      agentActivity: { id: 'activity-1', body: 'stop' },
    };
    const { rawBody, signature } = signBody(payload);

    const res = await request(app)
      .post('/linear/webhook')
      .set('Content-Type', 'application/json')
      .set('linear-signature', signature)
      .send(rawBody);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, stopped: true });
    expect(replyToTask).toHaveBeenCalledWith('manus-123', 'stop');
    expect(createAgentActivity).not.toHaveBeenCalled();
  });

  it('AgentSessionEvent prompted: handles stop signal from Linear UI', async () => {
    const { getValidToken } = await import('../../services/linearAuth');
    const { replyToTask } = await import('../../services/manusClient');
    const { findTaskBySession, findPendingTaskBySession } =
      await import('../../services/taskStore');

    (getValidToken as ReturnType<typeof vi.fn>).mockResolvedValue('mock-token');
    (findTaskBySession as ReturnType<typeof vi.fn>).mockReturnValue('manus-123');
    (findPendingTaskBySession as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    (replyToTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      taskId: 'manus-123',
      taskUrl: 'https://manus.ai/tasks/123',
    });

    // When Linear sends a stop request from the UI, it includes signal: "stop"
    // The body may be empty or contain stop-related text
    const payload = {
      type: 'AgentSessionEvent',
      action: 'prompted',
      organizationId: 'org-1',
      agentSession: { id: 'session-1' },
      agentActivity: { id: 'activity-1', body: 'Stop', signal: 'stop' },
    };
    const { rawBody, signature } = signBody(payload);

    const res = await request(app)
      .post('/linear/webhook')
      .set('Content-Type', 'application/json')
      .set('linear-signature', signature)
      .send(rawBody);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, stopped: true });
    expect(replyToTask).toHaveBeenCalledWith('manus-123', 'stop');
  });

  it('AgentSessionEvent prompted: ignores stop when no Manus task found', async () => {
    const { getValidToken } = await import('../../services/linearAuth');
    const { replyToTask } = await import('../../services/manusClient');
    const { findTaskBySession, findPendingTaskBySession } =
      await import('../../services/taskStore');
    const { createAgentActivity } = await import('../../services/linearAgentSession');

    (getValidToken as ReturnType<typeof vi.fn>).mockResolvedValue('mock-token');
    (findTaskBySession as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    (findPendingTaskBySession as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

    const payload = {
      type: 'AgentSessionEvent',
      action: 'prompted',
      organizationId: 'org-1',
      agentSession: { id: 'session-1' },
      agentActivity: { id: 'activity-1', body: 'stop' },
    };
    const { rawBody, signature } = signBody(payload);

    const res = await request(app)
      .post('/linear/webhook')
      .set('Content-Type', 'application/json')
      .set('linear-signature', signature)
      .send(rawBody);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, ignored: true, reason: 'no task in progress' });
    expect(replyToTask).not.toHaveBeenCalled();
    expect(createAgentActivity).not.toHaveBeenCalled();
  });

  it('AgentSessionEvent prompted: returns 422 when no Manus task found', async () => {
    const { getValidToken } = await import('../../services/linearAuth');
    const { findTaskBySession, findPendingTaskBySession } =
      await import('../../services/taskStore');

    (getValidToken as ReturnType<typeof vi.fn>).mockResolvedValue('mock-token');
    (findTaskBySession as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
    (findPendingTaskBySession as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

    const payload = {
      type: 'AgentSessionEvent',
      action: 'prompted',
      organizationId: 'org-1',
      agentSession: { id: 'session-1' },
      agentActivity: { id: 'activity-1', body: 'Please add tests' },
    };
    const { rawBody, signature } = signBody(payload);

    const res = await request(app)
      .post('/linear/webhook')
      .set('Content-Type', 'application/json')
      .set('linear-signature', signature)
      .send(rawBody);

    expect(res.status).toBe(422);
  });

  it('AgentSessionEvent prompted: ignores when missing data', async () => {
    const payload = {
      type: 'AgentSessionEvent',
      action: 'prompted',
      organizationId: 'org-1',
      agentSession: { id: 'session-1' },
      // no agentActivity.body
    };
    const { rawBody, signature } = signBody(payload);

    const res = await request(app)
      .post('/linear/webhook')
      .set('Content-Type', 'application/json')
      .set('linear-signature', signature)
      .send(rawBody);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, ignored: true });
  });
});

describe('Auth signal handling', () => {
  let app: Express.Application;
  let tempDir: string;

  beforeAll(async () => {
    process.env.LINEAR_WEBHOOK_SECRET = 'test-secret';
    process.env.LINEAR_CLIENT_ID = 'test-client-id';
    process.env.MANUS_API_KEY = 'test-manus-key';
    process.env.ENABLE_DEBUG_ENDPOINTS = 'false';
    process.env.MANUS_AUTH_URL = 'https://manus.ai/settings/integrations/github';
    tempDir = mkdtempSync(join(tmpdir(), 'linear-webhook-auth-test-'));
    process.env.DATA_DIR = tempDir;
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.resetModules();
  });

  it('emits auth elicitation when Manus returns GitHub auth error', async () => {
    vi.doMock('../../services/linearAuth', () => ({
      getValidToken: vi.fn().mockResolvedValue('mock-token'),
    }));
    vi.doMock('../../services/linearClient', () => ({
      getIssueDetails: vi.fn().mockResolvedValue({
        id: 'issue-1',
        title: 'Test',
        description: '',
        teamId: null,
        teamName: null,
        projectName: null,
        projectIdentifier: null,
        comments: [],
      }),
      findStateIdByName: vi.fn(),
      updateIssueState: vi.fn(),
      postComment: vi.fn(),
    }));
    vi.doMock('../../services/manusClient', () => ({
      createTaskWithFallback: vi
        .fn()
        .mockRejectedValue(
          new Error('GitHub authentication required: cannot access private repository')
        ),
      replyToTask: vi.fn(),
    }));
    vi.doMock('../../services/manusAttachments', () => ({
      buildManusAttachments: vi.fn().mockResolvedValue([]),
    }));
    vi.doMock('../../services/taskStore', () => ({
      findPendingTaskBySession: vi.fn().mockReturnValue({
        commentId: 'comment-1',
        record: {
          linearIssueId: 'issue-1',
          workspaceId: 'org-1',
          agentSessionId: 'session-1',
          prompt: 'test',
          attachments: [],
        },
      }),
      findTaskBySession: vi.fn().mockReturnValue(undefined),
      consumePendingTask: vi.fn(),
      removeTasksByIssue: vi.fn().mockReturnValue(0),
    }));
    vi.doMock('../../services/linearAgentSession', () => ({
      createAgentActivity: vi.fn().mockResolvedValue('activity-auth'),
      updateAgentSession: vi.fn(),
      emitAuthElicitation: vi.fn().mockResolvedValue('activity-auth'),
    }));

    app = (await import('../../index')).default;

    const payload = {
      type: 'AgentSessionEvent',
      action: 'prompted',
      organizationId: 'org-1',
      agentSession: { id: 'session-1' },
      agentActivity: { body: 'manus-1.6' },
    };
    const { rawBody, signature } = signBody(payload);

    const res = await request(app)
      .post('/linear/webhook')
      .set('Content-Type', 'application/json')
      .set('linear-signature', signature)
      .send(rawBody);

    expect(res.status).toBe(502);

    const { emitAuthElicitation } = await import('../../services/linearAgentSession');
    expect(emitAuthElicitation).toHaveBeenCalledWith(
      'session-1',
      'https://manus.ai/settings/integrations/github',
      'mock-token',
      { providerName: 'GitHub' }
    );
  });

  it('shows error activity when MANUS_AUTH_URL not configured', async () => {
    delete process.env.MANUS_AUTH_URL;

    vi.doMock('../../services/linearAuth', () => ({
      getValidToken: vi.fn().mockResolvedValue('mock-token'),
    }));
    vi.doMock('../../services/linearClient', () => ({
      getIssueDetails: vi.fn().mockResolvedValue({
        id: 'issue-1',
        title: 'Test',
        description: '',
        teamId: null,
        teamName: null,
        projectName: null,
        projectIdentifier: null,
        comments: [],
      }),
      findStateIdByName: vi.fn(),
      updateIssueState: vi.fn().mockResolvedValue(undefined),
      postComment: vi.fn().mockResolvedValue('comment-1'),
    }));
    vi.doMock('../../services/manusClient', () => ({
      createTaskWithFallback: vi
        .fn()
        .mockRejectedValue(new Error('GitHub authentication required')),
      replyToTask: vi.fn(),
    }));
    vi.doMock('../../services/manusAttachments', () => ({
      buildManusAttachments: vi.fn().mockResolvedValue([]),
    }));
    vi.doMock('../../services/taskStore', () => ({
      findPendingTaskBySession: vi.fn().mockReturnValue({
        commentId: 'comment-1',
        record: {
          linearIssueId: 'issue-1',
          workspaceId: 'org-1',
          agentSessionId: 'session-1',
          prompt: 'test',
          attachments: [],
        },
      }),
      findTaskBySession: vi.fn().mockReturnValue(undefined),
      consumePendingTask: vi.fn(),
      removeTasksByIssue: vi.fn().mockReturnValue(0),
    }));
    vi.doMock('../../services/linearAgentSession', () => ({
      createAgentActivity: vi.fn().mockResolvedValue('activity-err'),
      updateAgentSession: vi.fn().mockResolvedValue(undefined),
      emitAuthElicitation: vi.fn().mockResolvedValue(null),
    }));

    app = (await import('../../index')).default;

    const payload = {
      type: 'AgentSessionEvent',
      action: 'prompted',
      organizationId: 'org-1',
      agentSession: { id: 'session-1' },
      agentActivity: { body: 'manus-1.6' },
    };
    const { rawBody, signature } = signBody(payload);

    await request(app)
      .post('/linear/webhook')
      .set('Content-Type', 'application/json')
      .set('linear-signature', signature)
      .send(rawBody);

    const { emitAuthElicitation } = await import('../../services/linearAgentSession');
    // Should NOT call emitAuthElicitation since MANUS_AUTH_URL is not set
    expect(emitAuthElicitation).not.toHaveBeenCalled();

    const { createAgentActivity } = await import('../../services/linearAgentSession');
    expect(createAgentActivity).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        type: 'error',
        body: expect.stringContaining('Manus task creation failed'),
      }),
      'mock-token'
    );
  });
});
