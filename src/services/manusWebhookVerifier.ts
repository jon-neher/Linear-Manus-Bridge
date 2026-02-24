import { createHash, createVerify } from 'crypto';

const MANUS_PUBLIC_KEY_URL =
  (process.env.MANUS_API_BASE_URL ?? 'https://api.manus.ai') + '/v1/webhook/public_key';

/**
 * Maximum age (in seconds) for a webhook timestamp before it is rejected.
 * This prevents replay attacks.
 */
const MAX_TIMESTAMP_AGE_SECONDS = 300; // 5 minutes

/**
 * How long (in milliseconds) to cache the Manus public key before re-fetching.
 */
const PUBLIC_KEY_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

interface PublicKeyCache {
  pem: string;
  fetchedAt: number;
}

let publicKeyCache: PublicKeyCache | null = null;

/**
 * Fetch and cache the Manus RSA public key.
 * The key is cached for PUBLIC_KEY_CACHE_TTL_MS to avoid hammering the endpoint.
 */
async function getManusPublicKey(): Promise<string> {
  const now = Date.now();
  if (publicKeyCache && now - publicKeyCache.fetchedAt < PUBLIC_KEY_CACHE_TTL_MS) {
    return publicKeyCache.pem;
  }

  const apiKey = process.env.MANUS_API_KEY;
  if (!apiKey) {
    throw new Error('MANUS_API_KEY is not configured; cannot fetch Manus public key');
  }

  const response = await fetch(MANUS_PUBLIC_KEY_URL, {
    headers: { API_KEY: apiKey },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch Manus public key (${response.status}): ${await response.text()}`,
    );
  }

  const data = (await response.json()) as { public_key: string };
  if (!data.public_key) {
    throw new Error('Manus public key response missing "public_key" field');
  }

  publicKeyCache = { pem: data.public_key, fetchedAt: now };
  return data.public_key;
}

/**
 * Verify the RSA-SHA256 signature on an incoming Manus webhook request.
 *
 * Manus signs the concatenation of:
 *   {timestamp}.{full_webhook_url}.{sha256_hex_of_body}
 * using its private key, then Base64-encodes the result and sends it in
 * the X-Webhook-Signature header alongside X-Webhook-Timestamp.
 *
 * @param rawBody    Raw request body Buffer (must be captured before JSON parsing)
 * @param signature  Value of the X-Webhook-Signature header (Base64-encoded)
 * @param timestamp  Value of the X-Webhook-Timestamp header (Unix seconds string)
 * @param webhookUrl The full URL of the webhook endpoint that received the request
 * @returns          true if the signature is valid and the timestamp is fresh
 */
export async function verifyManusWebhookSignature(
  rawBody: Buffer,
  signature: string,
  timestamp: string,
  webhookUrl: string,
): Promise<boolean> {
  // 1. Validate timestamp freshness to prevent replay attacks.
  const requestTime = parseInt(timestamp, 10);
  if (isNaN(requestTime)) {
    console.warn('[ManusVerifier] Invalid X-Webhook-Timestamp header value:', timestamp);
    return false;
  }
  const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - requestTime);
  if (ageSeconds > MAX_TIMESTAMP_AGE_SECONDS) {
    console.warn(
      `[ManusVerifier] Webhook timestamp is ${ageSeconds}s old (max ${MAX_TIMESTAMP_AGE_SECONDS}s)`,
    );
    return false;
  }

  // 2. Reconstruct the content that Manus signed:
  //    {timestamp}.{url}.{sha256_hex_of_body}
  const bodyHash = createHash('sha256').update(rawBody).digest('hex');
  const signedContent = `${timestamp}.${webhookUrl}.${bodyHash}`;

  console.log('[ManusVerifier] Signed content components', {
    timestamp,
    webhookUrl,
    bodyHashPreview: bodyHash.slice(0, 16) + '…',
    signedContentPreview: signedContent.slice(0, 80) + '…',
  });

  // 3. Fetch (or use cached) Manus public key.
  let publicKeyPem: string;
  try {
    publicKeyPem = await getManusPublicKey();
  } catch (err) {
    console.error('[ManusVerifier] Could not retrieve Manus public key:', err);
    return false;
  }

  // 4. Verify the RSA-SHA256 signature (createVerify handles SHA256 hashing internally).
  try {
    const signatureBuffer = Buffer.from(signature, 'base64');
    const verifier = createVerify('RSA-SHA256');
    verifier.update(signedContent, 'utf8');
    const result = verifier.verify(publicKeyPem, signatureBuffer);
    console.log('[ManusVerifier] Signature verify result:', result);
    return result;
  } catch (err) {
    console.error('[ManusVerifier] Signature verification threw an error:', err);
    return false;
  }
}

/**
 * Invalidate the cached public key, forcing a fresh fetch on the next request.
 * Useful if you suspect the key has been rotated.
 */
export function invalidatePublicKeyCache(): void {
  publicKeyCache = null;
}
