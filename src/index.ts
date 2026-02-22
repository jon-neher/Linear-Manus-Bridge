import express from 'express';
import oauthRouter from './routes/oauth';
import webhookRouter from './routes/webhook';

const app = express();
const PORT = process.env.PORT || 3000;

// Webhook route uses express.raw() internally for HMAC verification;
// must be mounted before the global express.json() middleware.
app.use('/webhook', webhookRouter);

app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true }));
app.use('/oauth', oauthRouter);

app.listen(PORT, () => {
  console.log(`Linear-Manus Bridge listening on port ${PORT}`);
});

export default app;
