import express, { Request } from 'express';
import oauthRouter from './routes/oauth';
import webhookRouter from './routes/webhook';
import linearWebhookRouter from './routes/linearWebhook';
import manusWebhooksRouter from './routes/manusWebhooks';

const app = express();
const PORT = process.env.PORT || 3000;

// Capture raw body for webhook signature verification before JSON parsing.
app.use(
  express.json({
    verify: (req: Request & { rawBody?: Buffer }, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.get('/health', (_req, res) => res.json({ ok: true }));
app.use('/oauth', oauthRouter);
app.use('/webhook', webhookRouter);
app.use('/linear/webhook', linearWebhookRouter);
app.use('/manus/webhooks', manusWebhooksRouter);

app.listen(PORT, () => {
  console.log(`Linear-Manus Bridge listening on port ${PORT}`);
});

export default app;
