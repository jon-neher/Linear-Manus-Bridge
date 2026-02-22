const DEFAULT_MANUS_API_BASE_URL = 'https://api.manus.ai';

interface CreateWebhookResponse {
  webhook_id: string;
}

export async function createManusWebhook(url: string): Promise<{ webhookId: string }> {
  const apiKey = process.env.MANUS_API_KEY;
  if (!apiKey) {
    throw new Error('MANUS_API_KEY is not configured');
  }

  const baseUrl = process.env.MANUS_API_BASE_URL || DEFAULT_MANUS_API_BASE_URL;
  const response = await fetch(`${baseUrl}/v1/webhooks`, {
    method: 'POST',
    headers: {
      API_KEY: apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ webhook: { url } }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Manus webhook creation failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as CreateWebhookResponse;
  if (!data.webhook_id) {
    throw new Error('Manus webhook creation response missing webhook_id');
  }

  return { webhookId: data.webhook_id };
}
