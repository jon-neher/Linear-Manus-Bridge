import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';

// Mock the taskStore service
vi.mock('../../services/taskStore', () => ({
  getAllTasks: vi.fn(),
  getAllPendingTasks: vi.fn(),
}));

import * as taskStore from '../../services/taskStore';

describe('Stats endpoint', () => {
  let app: any;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'stats-test-'));
    process.env.DATA_DIR = tmpDir;
    process.env.PORT = '0';
    vi.resetModules();
    const mod = await import('../../index');
    app = mod.default;
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GET /stats returns task counts', async () => {
    // Setup mock values
    vi.mocked(taskStore.getAllTasks).mockReturnValue([
      ['task-1', { linearIssueId: 'issue-1', workspaceId: 'ws-1' }],
      ['task-2', { linearIssueId: 'issue-2', workspaceId: 'ws-1' }],
    ] as any);
    vi.mocked(taskStore.getAllPendingTasks).mockReturnValue([
      ['pending-1', { linearIssueId: 'issue-3', workspaceId: 'ws-1', prompt: 'test', attachments: [] }],
    ] as any);

    const res = await request(app).get('/stats');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      activeTasks: 2,
      pendingTasks: 1,
    });
  });

  it('GET /stats returns zero counts when stores are empty', async () => {
    vi.mocked(taskStore.getAllTasks).mockReturnValue([]);
    vi.mocked(taskStore.getAllPendingTasks).mockReturnValue([]);

    const res = await request(app).get('/stats');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      activeTasks: 0,
      pendingTasks: 0,
    });
  });
});
