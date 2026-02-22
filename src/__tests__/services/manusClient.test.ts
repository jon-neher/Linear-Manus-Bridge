import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('manusClient', () => {
  const TEST_BASE_URL = 'https://test-manus.example.com';
  let createTask: typeof import('../../services/manusClient').createTask;
  let replyToTask: typeof import('../../services/manusClient').replyToTask;

  beforeEach(async () => {
    process.env.MANUS_API_BASE_URL = TEST_BASE_URL;
    process.env.MANUS_API_KEY = 'test-manus-key';

    vi.resetModules();
    const mod = await import('../../services/manusClient');
    createTask = mod.createTask;
    replyToTask = mod.replyToTask;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('createTask', () => {
    it('returns taskId and taskUrl on success', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ task_id: 'task-123', task_url: 'https://manus.ai/task/123' }),
        }),
      );

      const result = await createTask('Do something');

      expect(result).toEqual({ taskId: 'task-123', taskUrl: 'https://manus.ai/task/123' });
    });

    it('throws when MANUS_API_KEY is not set', async () => {
      delete process.env.MANUS_API_KEY;

      await expect(createTask('Do something')).rejects.toThrow('MANUS_API_KEY is not configured');
    });

    it('throws with status on non-ok response', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
          text: async () => 'Internal Server Error',
        }),
      );

      await expect(createTask('Do something')).rejects.toThrow('Manus task creation failed (500)');
    });

    it('throws when response is missing task_id', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({}),
        }),
      );

      await expect(createTask('Do something')).rejects.toThrow('Manus response missing task_id');
    });

    it('sends correct headers and body', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ task_id: 'task-456' }),
      });
      vi.stubGlobal('fetch', mockFetch);

      await createTask('Build a widget', { agentProfile: 'custom-agent', taskMode: 'plan' });

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe(`${TEST_BASE_URL}/v1/tasks`);
      expect(init.method).toBe('POST');
      expect(init.headers).toMatchObject({
        'Content-Type': 'application/json',
        API_KEY: 'test-manus-key',
      });

      const body = JSON.parse(init.body);
      expect(body).toMatchObject({
        prompt: 'Build a widget',
        agentProfile: 'custom-agent',
        taskMode: 'plan',
        interactiveMode: true,
      });
    });
  });

  describe('replyToTask', () => {
    it('returns taskId and taskUrl on success', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ task_id: 'task-789', task_url: 'https://manus.ai/task/789' }),
        }),
      );

      const result = await replyToTask('task-789', 'Here is more info');
      expect(result).toEqual({ taskId: 'task-789', taskUrl: 'https://manus.ai/task/789' });
    });

    it('throws when MANUS_API_KEY is not set', async () => {
      delete process.env.MANUS_API_KEY;
      await expect(replyToTask('task-1', 'msg')).rejects.toThrow('MANUS_API_KEY is not configured');
    });

    it('throws with status on non-ok response', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 403,
          text: async () => 'Forbidden',
        }),
      );
      await expect(replyToTask('task-1', 'msg')).rejects.toThrow('Manus reply failed (403)');
    });
  });
});
