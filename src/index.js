'use strict';

const express = require('express');
const oauthRouter = require('./routes/oauth');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true }));
app.use('/oauth', oauthRouter);

app.listen(PORT, () => {
  console.log(`Linear-Manus Bridge listening on port ${PORT}`);
});

module.exports = app;
