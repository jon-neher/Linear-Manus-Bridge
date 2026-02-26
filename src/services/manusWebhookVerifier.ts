import { createHash, createVerify } from 'crypto';
import {
  MANUS_API_BASE_URL,
  MAX_WEBHOOK_TIMESTAMP_AGE_SECONDS,
  PUBLIC_KEY_CACHE_TTL_MS,
} from './constants';
import { createLogger } from './logger';

const log = createLogger('ManusVerifier');

const MANUS_PUBLIC_KEY_URL = `${MANUS_API_BASE_URL}/v1/webhook/public_key`;

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
    log.warn({ timestamp }, 'Invalid X-Webhook-Timestamp header value');
    return false;
  }
  const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - requestTime);
  if (ageSeconds > MAX_WEBHOOK_TIMESTAMP_AGE_SECONDS) {
    log.warn(
      { ageSeconds, maxAge: MAX_WEBHOOK_TIMESTAMP_AGE_SECONDS },
      'Webhook timestamp too old',
    );
    return false;
  }

  // 2. Reconstruct the content that Manus signed:
  //    {timestamp}.{url}.{sha256_hex_of_body}
  const bodyHash = createHash('sha256').update(rawBody).digest('hex');
  const signedContent = `${timestamp}.${webhookUrl}.${bodyHash}`;

  log.debug({
    timestamp,
    webhookUrl,
    bodyHashPreview: bodyHash.slice(0, 16) + '…',
    signedContentPreview: signedContent.slice(0, 80) + '…',
  }, 'Signed content components');

  // 3. Fetch (or use cached) Manus public key.
  let publicKeyPem: string;
  try {
    publicKeyPem = await getManusPublicKey();
  } catch (err) {
    log.error({ err }, 'Could not retrieve Manus public key');
    return false;
  }

  // 4. Verify the RSA-SHA256 signature (createVerify handles SHA256 hashing internally).
  try {
    const signatureBuffer = Buffer.from(signature, 'base64');
    const verifier = createVerify('RSA-SHA256');
    verifier.update(signedContent, 'utf8');
    const result = verifier.verify(publicKeyPem, signatureBuffer);
    log.debug({ result }, 'Signature verify result');
    return result;
  } catch (err) {
    log.error({ err }, 'Signature verification threw an error');
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
