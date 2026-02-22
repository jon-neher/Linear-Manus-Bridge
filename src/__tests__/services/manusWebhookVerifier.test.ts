import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { generateKeyPairSync, createHash, createSign, KeyObject } from 'crypto';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicKeyPem = publicKey.export({ type: 'pkcs1', format: 'pem' }) as string;

function signPayload(body: Buffer, timestamp: string, url: string, privKey: KeyObject): string {
  const bodyHash = createHash('sha256').update(body).digest('hex');
  const signedContent = `${timestamp}.${url}.${bodyHash}`;
  const contentHash = createHash('sha256').update(signedContent, 'utf8').digest();
  const signer = createSign('RSA-SHA256');
  signer.update(contentHash);
  return signer.sign(privKey, 'base64');
}

function mockPublicKeyFetch(): ReturnType<typeof vi.fn> {
  const mockFetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ public_key: publicKeyPem }),
  });
  vi.stubGlobal('fetch', mockFetch);
  return mockFetch;
}

describe('manusWebhookVerifier', () => {
  const TEST_BASE_URL = 'https://test-manus.example.com';
  const WEBHOOK_URL = 'https://example.com/webhooks/manus';
  let verifyManusWebhookSignature: typeof import('../../services/manusWebhookVerifier').verifyManusWebhookSignature;
  let invalidatePublicKeyCache: typeof import('../../services/manusWebhookVerifier').invalidatePublicKeyCache;

  beforeEach(async () => {
    process.env.MANUS_API_BASE_URL = TEST_BASE_URL;
    process.env.MANUS_API_KEY = 'test-manus-key';

    vi.resetModules();
    const mod = await import('../../services/manusWebhookVerifier');
    verifyManusWebhookSignature = mod.verifyManusWebhookSignature;
    invalidatePublicKeyCache = mod.invalidatePublicKeyCache;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns true for a valid signature', async () => {
    mockPublicKeyFetch();

    const body = Buffer.from(JSON.stringify({ event: 'task.completed' }));
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = signPayload(body, timestamp, WEBHOOK_URL, privateKey);

    const result = await verifyManusWebhookSignature(body, signature, timestamp, WEBHOOK_URL);

    expect(result).toBe(true);
  });

  it('returns false for an invalid signature (tampered body)', async () => {
    mockPublicKeyFetch();

    const body = Buffer.from(JSON.stringify({ event: 'task.completed' }));
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = signPayload(body, timestamp, WEBHOOK_URL, privateKey);

    const tamperedBody = Buffer.from(JSON.stringify({ event: 'task.failed' }));
    const result = await verifyManusWebhookSignature(
      tamperedBody,
      signature,
      timestamp,
      WEBHOOK_URL,
    );

    expect(result).toBe(false);
  });

  it('returns false for an expired timestamp (>300s old)', async () => {
    mockPublicKeyFetch();

    const body = Buffer.from(JSON.stringify({ event: 'task.completed' }));
    const expiredTimestamp = String(Math.floor(Date.now() / 1000) - 400);
    const signature = signPayload(body, expiredTimestamp, WEBHOOK_URL, privateKey);

    const result = await verifyManusWebhookSignature(
      body,
      signature,
      expiredTimestamp,
      WEBHOOK_URL,
    );

    expect(result).toBe(false);
  });

  it('returns false for an invalid timestamp (NaN)', async () => {
    mockPublicKeyFetch();

    const body = Buffer.from(JSON.stringify({ event: 'task.completed' }));
    const result = await verifyManusWebhookSignature(body, 'some-sig', 'not-a-number', WEBHOOK_URL);

    expect(result).toBe(false);
  });

  it('returns false when public key fetch fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      }),
    );

    const body = Buffer.from(JSON.stringify({ event: 'task.completed' }));
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = signPayload(body, timestamp, WEBHOOK_URL, privateKey);

    const result = await verifyManusWebhookSignature(body, signature, timestamp, WEBHOOK_URL);

    expect(result).toBe(false);
  });

  it('caches public key and invalidatePublicKeyCache forces re-fetch', async () => {
    const mockFetch = mockPublicKeyFetch();

    const body = Buffer.from(JSON.stringify({ event: 'test' }));
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = signPayload(body, timestamp, WEBHOOK_URL, privateKey);

    // First call fetches the key
    await verifyManusWebhookSignature(body, signature, timestamp, WEBHOOK_URL);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Second call uses the cache — no additional fetch
    const timestamp2 = String(Math.floor(Date.now() / 1000));
    const signature2 = signPayload(body, timestamp2, WEBHOOK_URL, privateKey);
    await verifyManusWebhookSignature(body, signature2, timestamp2, WEBHOOK_URL);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Invalidate the cache and verify it re-fetches
    invalidatePublicKeyCache();
    const timestamp3 = String(Math.floor(Date.now() / 1000));
    const signature3 = signPayload(body, timestamp3, WEBHOOK_URL, privateKey);
    await verifyManusWebhookSignature(body, signature3, timestamp3, WEBHOOK_URL);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
