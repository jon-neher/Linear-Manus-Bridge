# CLAUDE.md — Linear-Manus Bridge

## What This Project Does

A middleware bridge between Linear and Manus. Linear issues delegated to the Manus app trigger webhook events → this service creates Manus tasks → Manus completion callbacks update the Linear issue state and post result comments.

## Build & Verify

```bash
npm run build        # Compile TypeScript
npm run type-check   # Type-check without emitting
npm test             # Run test suite (vitest)
npm run test:watch   # Run tests in watch mode
npm start            # Run the compiled server
```

Tests live in `src/__tests__/` (excluded from tsc build). CI runs type-check + tests on Node 18/20/22 via GitHub Actions.

## Code Layout

- `src/index.ts` — Express app setup with raw body capture for signature verification
- `src/routes/` — Route handlers for Linear webhooks, Manus webhooks, and OAuth
- `src/services/` — Business logic: Linear GraphQL client, Manus API client, token management, webhook verification, encrypted installation store, in-memory task store

## Key Things to Know

- **TypeScript strict mode**, CommonJS output, ES2022 target
- **No shared types file** — interfaces are defined locally in each file
- **Native `fetch`** — no axios or node-fetch; requires Node ≥ 18
- **Two webhook paths** in `linearWebhook.ts`: AgentSessionEvent (primary) and legacy Issue assignment (backwards compat)
- **Encrypted token storage** — `installationStore.ts` uses AES-256-GCM; never log or expose tokens
- **In-memory task store** — `taskStore.ts` is a plain `Map`; data lost on restart (known limitation)
- **Webhook signature verification** — Linear uses HMAC-SHA256; Manus uses RSA-SHA256 with cached public key
- **Token auto-refresh** — `linearAuth.ts` handles refresh with 5-min buffer and concurrent request dedup
- **Error shape** — always `{ error: string }` for failures, `{ ok: true, ... }` for success

## Environment Variables

Secrets come from env vars (see `env.example` and `README.md`). Never hardcode secrets. `INSTALLATION_STORE_SECRET` encrypts the token store on disk.

## Style Conventions

- Prefix console logs with `[module/context]` (e.g., `[linear/webhook]`)
- Keep interfaces co-located with the code that uses them
- Use Express `Router()` pattern for route modules
- No comments unless logic is non-obvious
