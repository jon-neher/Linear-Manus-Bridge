import express from 'express';
import oauthRouter from './routes/oauth';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true }));
app.use('/oauth', oauthRouter);

app.listen(PORT, () => {
  console.log(`Linear-Manus Bridge listening on port ${PORT}`);
});

export default app;
