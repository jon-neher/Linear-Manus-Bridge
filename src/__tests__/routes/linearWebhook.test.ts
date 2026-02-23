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
}));
vi.mock('../../services/taskStore', () => ({
  storeTask: vi.fn(),
  getTask: vi.fn(),
  storePendingTask: vi.fn(),
  getPendingTask: vi.fn(),
  consumePendingTask: vi.fn(),
  findTaskByQuestionCommentId: vi.fn(),
  findTaskBySession: vi.fn(),
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

    (getValidToken as ReturnType<typeof vi.fn>).mockResolvedValue('mock-token');
    (getIssueDetails as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'issue-1', title: 'Test', description: 'Desc', teamId: 'team-1', comments: [],
    });
    (postComment as ReturnType<typeof vi.fn>).mockResolvedValue('comment-1');
    (buildManusAttachments as ReturnType<typeof vi.fn>).mockResolvedValue([]);

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
    expect(storePendingTask).toHaveBeenCalledWith('comment-1', expect.objectContaining({
      connectors: ['bbb0df76-66bd-4a24-ae4f-2aac4750d90b'],
    }));
  });

  it('AgentSessionEvent created: allows opt-out of GitHub connector', async () => {
    const { getValidToken } = await import('../../services/linearAuth');
    const { getIssueDetails, postComment } = await import('../../services/linearClient');
    const { buildManusAttachments } = await import('../../services/manusAttachments');
    const { storePendingTask } = await import('../../services/taskStore');

    (getValidToken as ReturnType<typeof vi.fn>).mockResolvedValue('mock-token');
    (getIssueDetails as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'issue-1',
      title: 'Test',
      description: 'Desc',
      teamId: 'team-1',
      comments: [{ body: '/manus connectors=none' }],
    });
    (postComment as ReturnType<typeof vi.fn>).mockResolvedValue('comment-1');
    (buildManusAttachments as ReturnType<typeof vi.fn>).mockResolvedValue([]);

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
    expect(storePendingTask).toHaveBeenCalledWith('comment-1', expect.objectContaining({
      connectors: [],
    }));
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
    const { getPendingTask, consumePendingTask, storeTask } = await import('../../services/taskStore');
    const { createTaskWithFallback } = await import('../../services/manusClient');

    (getValidToken as ReturnType<typeof vi.fn>).mockResolvedValue('mock-token');
    (getPendingTask as ReturnType<typeof vi.fn>).mockReturnValue({
      linearIssueId: 'issue-1',
      linearTeamId: 'team-1',
      workspaceId: 'org-1',
      agentSessionId: 'session-1',
      prompt: 'Prompt',
      attachments: [],
      connectors: ['github-connector'],
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
    expect(createTaskWithFallback).toHaveBeenCalledWith('Prompt', expect.objectContaining({
      connectors: ['github-connector'],
    }));
    expect(consumePendingTask).toHaveBeenCalledWith('comment-1');
    expect(storeTask).toHaveBeenCalled();
  });

  it('AgentSessionEvent prompted: forwards reply to Manus', async () => {
    const { getValidToken } = await import('../../services/linearAuth');
    const { replyToTask } = await import('../../services/manusClient');
    const { findTaskBySession } = await import('../../services/taskStore');

    (getValidToken as ReturnType<typeof vi.fn>).mockResolvedValue('mock-token');
    (findTaskBySession as ReturnType<typeof vi.fn>).mockReturnValue('manus-123');
    (replyToTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      taskId: 'manus-123', taskUrl: 'https://manus.ai/tasks/123',
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

  it('AgentSessionEvent prompted: returns 422 when no Manus task found', async () => {
    const { getValidToken } = await import('../../services/linearAuth');
    const { findTaskBySession } = await import('../../services/taskStore');

    (getValidToken as ReturnType<typeof vi.fn>).mockResolvedValue('mock-token');
    (findTaskBySession as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

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
