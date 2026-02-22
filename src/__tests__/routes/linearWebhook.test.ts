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
}));
vi.mock('../../services/manusClient', () => ({
  createTask: vi.fn(),
}));
vi.mock('../../services/taskStore', () => ({
  storeTask: vi.fn(),
  getTask: vi.fn(),
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
    const { getIssueDetails, findStateIdByName } = await import('../../services/linearClient');
    const { createTask } = await import('../../services/manusClient');

    (getValidToken as ReturnType<typeof vi.fn>).mockResolvedValue('mock-token');
    (getIssueDetails as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'issue-1',
      title: 'Test',
      description: 'Desc',
      teamId: 'team-1',
      comments: [],
    });
    (findStateIdByName as ReturnType<typeof vi.fn>).mockResolvedValue('state-1');
    (createTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      taskId: 'manus-123',
      taskUrl: 'https://manus.ai/tasks/123',
    });

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

  it('ignores non-Issue, non-AgentSessionEvent types', async () => {
    const payload = { type: 'Comment', action: 'create' };
    const { rawBody, signature } = signBody(payload);

    const res = await request(app)
      .post('/linear/webhook')
      .set('Content-Type', 'application/json')
      .set('linear-signature', signature)
      .send(rawBody);

    expect(res.status).toBe(200);
  });

  it('AgentSessionEvent created: returns { ok: true, taskId }', async () => {
    const { getValidToken } = await import('../../services/linearAuth');
    const { getIssueDetails, findStateIdByName } = await import('../../services/linearClient');
    const { createTask } = await import('../../services/manusClient');

    (getValidToken as ReturnType<typeof vi.fn>).mockResolvedValue('mock-token');
    (getIssueDetails as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'issue-1', title: 'Test', description: 'Desc', teamId: 'team-1', comments: [],
    });
    (findStateIdByName as ReturnType<typeof vi.fn>).mockResolvedValue('state-1');
    (createTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      taskId: 'manus-123', taskUrl: 'https://manus.ai/tasks/123',
    });

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
    expect(res.body).toMatchObject({ ok: true, taskId: 'manus-123' });
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
});
