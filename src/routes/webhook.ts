import { createHmac } from 'crypto';
import { Router, Request, Response } from 'express';

const router = Router();

function verifySignature(body: string, signature: string, secret: string): boolean {
  const hmac = createHmac('sha256', secret);
  hmac.update(body);
  const digest = hmac.digest('hex');
  return signature === digest;
}

/**
 * POST /webhook/linear
 * Receives Linear webhook events.
 */
router.post('/linear', (req: Request, res: Response): void => {
  const signature = req.headers['linear-signature'] as string | undefined;
  const secret = process.env.LINEAR_WEBHOOK_SECRET;

  if (secret && signature) {
    const rawBody = JSON.stringify(req.body);
    if (!verifySignature(rawBody, signature, secret)) {
      res.status(401).json({ error: 'Invalid webhook signature' });
      return;
    }
  }

  const { action, type, data } = req.body as {
    action?: string;
    type?: string;
    data?: Record<string, unknown>;
  };

  console.log(`Webhook received: type=${type} action=${action}`);

  // Acknowledge quickly to meet Linear's 10-second timeout
  res.status(200).json({ ok: true });

  // TODO: Process webhook payload asynchronously (e.g. forward to Manus)
  if (type === 'Issue' && data) {
    console.log(`Issue event: action=${action} id=${data.id} title=${data.title}`);
  }
});

export default router;
