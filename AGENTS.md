# AGENTS.md — Linear-Manus Bridge

## Build / Verify
- `npm run build` — compile TypeScript (`tsc` → `dist/`)
- `npm run type-check` — type-check only (`tsc --noEmit`)
- `npm start` — run compiled server; `npm run dev` — watch mode
- `npm test` — run test suite (vitest)
- `npm run test:watch` — run tests in watch mode
- `npm run test:coverage` — run tests with coverage report

## Architecture
- Express 4 / TypeScript (strict, ES2022, CommonJS) / Node ≥ 18 / native `fetch`
- `src/routes/` — webhook handlers: `linearWebhook.ts` (Linear AgentSession events + legacy), `webhook.ts` (Manus callbacks), `oauth.ts`, `manusWebhooks.ts`
- `src/services/` — `linearClient.ts` (GraphQL), `linearAgentSession.ts` (agent activities), `linearAuth.ts` (OAuth + token refresh), `manusClient.ts` (task API), `installationStore.ts` (AES-256-GCM encrypted token store on disk), `taskStore.ts` (in-memory Map)
- Webhook security: Linear uses HMAC-SHA256; Manus uses RSA-SHA256 with cached public key
- Agent session lifecycle: emit `thought` within 10s of `created` event → forward Manus progress as `action` activities → emit `response` on completion or `ask`; `prompted` events forward user replies to Manus via multi-turn

## Code Style
- Interfaces defined inline per file (no shared types file)
- Error responses: `{ error: string }`; success: `{ ok: true, ... }`
- Console logs prefixed `[module/context]` (e.g. `[linear/webhook]`)
- Express `Router()` pattern per route module; never log/expose secrets
- Keep env vars in `env.example`; required: `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`, `LINEAR_REDIRECT_URI`, `LINEAR_WEBHOOK_SECRET`, `MANUS_API_KEY`, `INSTALLATION_STORE_SECRET`, `SERVICE_BASE_URL`, `DATA_DIR`
