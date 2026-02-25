import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { MANUS_API_BASE_URL } from './constants';
import { fetchWithTimeout } from './fetchWithTimeout';
import { isTimeoutError, handleTimeoutError } from './timeoutErrorHandler';

interface CreateWebhookResponse {
  webhook_id: string;
}

function getWebhookStorePath(): string {
  const dir = process.env.DATA_DIR ?? process.cwd();
  mkdirSync(dir, { recursive: true });
  return join(dir, '.manus-webhook.json');
}

function loadStoredWebhookId(): string | null {
  try {
    const raw = readFileSync(getWebhookStorePath(), 'utf8');
    const data = JSON.parse(raw) as { webhookId?: string };
    return data.webhookId ?? null;
  } catch {
    return null;
  }
}

function persistWebhookId(webhookId: string): void {
  try {
    writeFileSync(getWebhookStorePath(), JSON.stringify({ webhookId }), 'utf8');
  } catch (err) {
    console.error('[manusWebhooks] Failed to persist webhook ID:', err);
  }
}

export async function createManusWebhook(url: string): Promise<{ webhookId: string }> {
  const apiKey = process.env.MANUS_API_KEY;
  if (!apiKey) {
    throw new Error('MANUS_API_KEY is not configured');
  }

  try {
    const response = await fetchWithTimeout(`${MANUS_API_BASE_URL}/v1/webhooks`, {
      method: 'POST',
      headers: {
        API_KEY: apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ webhook: { url } }),
    });

    if (!response.ok) {
      const text = await response.text();
      // 409 means the webhook URL already exists — treat as success
      if (response.status === 409) {
        console.log('[manusWebhooks] Webhook URL already registered (409) — reusing existing');
        return { webhookId: '__existing__' };
      }
      throw new Error(`Manus webhook creation failed (${response.status}): ${text}`);
    }

    const data = (await response.json()) as CreateWebhookResponse;
    if (!data.webhook_id) {
      throw new Error('Manus webhook creation response missing webhook_id');
    }

    return { webhookId: data.webhook_id };
  } catch (error) {
    if (isTimeoutError(error)) {
      throw new Error(handleTimeoutError('createManusWebhook', error));
    }
    throw error;
  }
}

export async function deleteManusWebhook(webhookId: string): Promise<void> {
  const apiKey = process.env.MANUS_API_KEY;
  if (!apiKey) return;

  try {
    const response = await fetchWithTimeout(`${MANUS_API_BASE_URL}/v1/webhooks/${webhookId}`, {
      method: 'DELETE',
      headers: { API_KEY: apiKey },
    });

    if (!response.ok && response.status !== 404) {
      const text = await response.text();
      console.warn(`[manusWebhooks] Delete webhook failed (${response.status}): ${text}`);
    }
  } catch (error) {
    if (isTimeoutError(error)) {
      console.warn(`[manusWebhooks] Delete webhook timeout: ${handleTimeoutError('deleteManusWebhook', error)}`);
    } else {
      throw error;
    }
  }
}

/**
 * Register (or re-register) the Manus webhook on startup.
 * Deletes any previously stored webhook first to avoid duplicates,
 * then creates a fresh one pointing to SERVICE_BASE_URL/webhook/manus.
 */
export async function ensureManusWebhook(): Promise<void> {
  const baseUrl = process.env.SERVICE_BASE_URL?.replace(/\/$/, '');
  if (!baseUrl) {
    console.warn('[manusWebhooks] SERVICE_BASE_URL not set — skipping webhook registration');
    return;
  }
  if (!process.env.MANUS_API_KEY) {
    console.warn('[manusWebhooks] MANUS_API_KEY not set — skipping webhook registration');
    return;
  }

  const webhookUrl = `${baseUrl}/webhook/manus`;

  // Clean up previous webhook if stored
  const previousId = loadStoredWebhookId();
  if (previousId) {
    console.log('[manusWebhooks] Deleting previous webhook:', previousId);
    await deleteManusWebhook(previousId).catch((err) =>
      console.warn('[manusWebhooks] Failed to delete previous webhook:', err),
    );
  }

  try {
    const { webhookId } = await createManusWebhook(webhookUrl);
    persistWebhookId(webhookId);
    console.log('[manusWebhooks] Webhook registered:', { webhookId, url: webhookUrl });
  } catch (err) {
    console.error('[manusWebhooks] Failed to register webhook:', err);
  }
}
