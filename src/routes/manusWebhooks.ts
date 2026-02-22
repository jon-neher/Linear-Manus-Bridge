import { Router, Request, Response } from 'express';
import { createManusWebhook } from '../services/manusWebhooks';

const router = Router();

router.post('/', async (req: Request, res: Response): Promise<void> => {
  const { url } = req.body as { url?: string };

  if (!url) {
    res.status(400).json({ error: 'Missing webhook url' });
    return;
  }

  try {
    const { webhookId } = await createManusWebhook(url);
    res.status(201).json({ webhookId });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

export default router;
