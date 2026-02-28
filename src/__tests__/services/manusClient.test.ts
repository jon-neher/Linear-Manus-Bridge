import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('manusClient', () => {
  const TEST_BASE_URL = 'https://test-manus.example.com';
  let createTaskWithFallback: typeof import('../../services/manusClient').createTaskWithFallback;
  let createFileRecord: typeof import('../../services/manusClient').createFileRecord;
  let uploadFileToManus: typeof import('../../services/manusClient').uploadFileToManus;
  let replyToTask: typeof import('../../services/manusClient').replyToTask;

  beforeEach(async () => {
    process.env.MANUS_API_BASE_URL = TEST_BASE_URL;
    process.env.MANUS_API_KEY = 'test-manus-key';

    vi.resetModules();
    const mod = await import('../../services/manusClient');
    createTaskWithFallback = mod.createTaskWithFallback;
    createFileRecord = mod.createFileRecord;
    uploadFileToManus = mod.uploadFileToManus;
    replyToTask = mod.replyToTask;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('createTaskWithFallback', () => {
    it('returns taskId and taskUrl on success', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ task_id: 'task-123', task_url: 'https://manus.ai/task/123' }),
        })
      );

      const result = await createTaskWithFallback('Do something');

      expect(result).toEqual({
        taskId: 'task-123',
        taskUrl: 'https://manus.ai/task/123',
        usedProfile: 'manus-1.6',
        fallbackToLite: false,
      });
    });

    it('throws when MANUS_API_KEY is not set', async () => {
      delete process.env.MANUS_API_KEY;

      await expect(createTaskWithFallback('Do something')).rejects.toThrow(
        'MANUS_API_KEY is not configured'
      );
    });

    it('throws with status on non-ok response', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
          text: async () => 'Internal Server Error',
        })
      );

      await expect(createTaskWithFallback('Do something')).rejects.toThrow(
        'Manus task creation failed (500)'
      );
    });

    it('throws when response is missing task_id', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({}),
        })
      );

      await expect(createTaskWithFallback('Do something')).rejects.toThrow(
        'Manus response missing task_id'
      );
    });

    it('sends correct headers and body', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ task_id: 'task-456' }),
      });
      vi.stubGlobal('fetch', mockFetch);

      await createTaskWithFallback('Build a widget', {
        agentProfile: 'custom-agent',
        taskMode: 'plan',
        connectors: ['connector-1'],
      });

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
        connectors: ['connector-1'],
      });
    });

    it('falls back to lite on credit errors', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          status: 402,
          text: async () => 'Insufficient credits',
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ task_id: 'task-lite' }),
        });
      vi.stubGlobal('fetch', mockFetch);

      const result = await createTaskWithFallback('Test', { agentProfile: 'manus-1.6-max' });
      expect(result.usedProfile).toBe('manus-1.6-lite');
      expect(result.fallbackToLite).toBe(true);
    });
  });

  describe('createFileRecord', () => {
    it('returns file metadata', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ id: 'file-1', upload_url: 'https://upload' }),
        })
      );

      const result = await createFileRecord('data.txt');
      expect(result.id).toBe('file-1');
      expect(result.upload_url).toBe('https://upload');
    });
  });

  describe('uploadFileToManus', () => {
    it('uploads file content via PUT', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', mockFetch);

      await uploadFileToManus('https://upload', Buffer.from('data'), 'text/plain');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://upload',
        expect.objectContaining({ method: 'PUT' })
      );
    });
  });

  describe('replyToTask', () => {
    it('returns taskId and taskUrl on success', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({ task_id: 'task-789', task_url: 'https://manus.ai/task/789' }),
        })
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
        })
      );
      await expect(replyToTask('task-1', 'msg')).rejects.toThrow('Manus reply failed (403)');
    });
  });
});
