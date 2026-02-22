import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';

describe('Health endpoint', () => {
  let app: Express.Application;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'health-test-'));
    process.env.DATA_DIR = tmpDir;
    process.env.PORT = '0';
    vi.resetModules();
    const mod = await import('../../index');
    app = mod.default;
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GET /health returns { ok: true }', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
