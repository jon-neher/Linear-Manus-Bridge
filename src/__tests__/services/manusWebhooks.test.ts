import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('manusWebhooks', () => {
  const TEST_BASE_URL = 'https://test-manus.example.com';
  let createManusWebhook: typeof import('../../services/manusWebhooks').createManusWebhook;

  beforeEach(async () => {
    process.env.MANUS_API_BASE_URL = TEST_BASE_URL;
    process.env.MANUS_API_KEY = 'test-manus-key';

    vi.resetModules();
    const mod = await import('../../services/manusWebhooks');
    createManusWebhook = mod.createManusWebhook;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns webhookId on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ webhook_id: 'wh-001' }),
      })
    );

    const result = await createManusWebhook('https://example.com/webhook');

    expect(result).toEqual({ webhookId: 'wh-001' });
  });

  it('throws when MANUS_API_KEY is not set', async () => {
    delete process.env.MANUS_API_KEY;

    await expect(createManusWebhook('https://example.com/webhook')).rejects.toThrow(
      'MANUS_API_KEY is not configured'
    );
  });

  it('throws with status on non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        text: async () => 'Unprocessable Entity',
      })
    );

    await expect(createManusWebhook('https://example.com/webhook')).rejects.toThrow(
      'Manus webhook creation failed (422)'
    );
  });

  it('throws when response is missing webhook_id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({}),
      })
    );

    await expect(createManusWebhook('https://example.com/webhook')).rejects.toThrow(
      'Manus webhook creation response missing webhook_id'
    );
  });

  it('sends correct headers and body', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ webhook_id: 'wh-002' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await createManusWebhook('https://example.com/hook');

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(`${TEST_BASE_URL}/v1/webhooks`);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/json',
      API_KEY: 'test-manus-key',
    });

    const body = JSON.parse(init.body);
    expect(body).toEqual({ webhook: { url: 'https://example.com/hook' } });
  });
});
