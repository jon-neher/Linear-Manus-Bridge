import express, { Request } from 'express';
import oauthRouter from './routes/oauth';
import statsRouter from './routes/stats';
import webhookRouter from './routes/webhook';
import linearWebhookRouter from './routes/linearWebhook';
import manusWebhooksRouter from './routes/manusWebhooks';
import { getAllTasks, getAllPendingTasks } from './services/taskStore';
import { ensureManusWebhook } from './services/manusWebhooks';
import { createLogger } from './services/logger';

const log = createLogger('http');

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

// Log every incoming request for debugging webhook delivery
app.use((req, _res, next) => {
  if (req.path !== '/health') {
    log.info({ method: req.method, path: req.path }, 'incoming request');
  }
  next();
});

app.get('/health', (_req, res) => res.json({ ok: true }));

const enableDebugEndpoints = process.env.ENABLE_DEBUG_ENDPOINTS === 'true';
if (enableDebugEndpoints) {
  app.get('/debug/tasks', (_req, res) => {
    const tasks = getAllTasks().map(([id, r]) => ({
      taskId: id,
      linearIssueId: r.linearIssueId,
      hasAgentSession: !!r.agentSessionId,
      hasProgressComment: !!r.progressCommentId,
      hasQuestionComment: !!r.questionCommentId,
    }));
    const pending = getAllPendingTasks().map(([id, r]) => ({
      key: id,
      linearIssueId: r.linearIssueId,
      hasAgentSession: !!r.agentSessionId,
    }));
    res.json({ tasks, pending });
  });
}

app.use('/stats', statsRouter);
app.use('/oauth', oauthRouter);
app.use('/webhook', webhookRouter);
app.use('/linear/webhook', linearWebhookRouter);
app.use('/manus/webhooks', manusWebhooksRouter);

app.listen(PORT, () => {
  log.info({ port: PORT }, 'Linear-Manus Bridge listening');

  // Register Manus webhook after server is ready (Manus sends a verification ping)
  ensureManusWebhook().catch((err) =>
    log.error({ err }, 'Manus webhook registration failed'),
  );
});

export default app;
