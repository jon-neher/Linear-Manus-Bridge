# Linear-Manus Bridge

A lightweight middleware service that connects Linear to Manus. When a user delegates a Linear issue to the Manus app, the bridge receives the webhook, creates a Manus task with the issue context as the prompt, and updates the Linear issue state in real time as the task progresses.

---

## Architecture

```
Linear (AgentSessionEvent webhook)
        │
        ▼
┌─────────────────────────────┐
│   Linear-Manus Bridge       │  ← This service (Node.js / Express)
│                             │
│  POST /linear/webhook       │  ← Receives delegation events from Linear
│  POST /webhook/manus        │  ← Receives task completion callbacks from Manus
│  GET  /oauth/install        │  ← Initiates OAuth installation flow
│  GET  /oauth/callback       │  ← Handles OAuth redirect from Linear
│  GET  /oauth/installations  │  ← Diagnostic: lists stored installations
│  GET  /health               │  ← Health check
└─────────────────────────────┘
        │                  │
        ▼                  ▼
  Manus API           Linear GraphQL API
  (create task)       (update issue state / post comment)
```

### How it works

1. A user delegates a Linear issue to the **Manus** app user via the agent session UI ("Connect Manus").
2. Linear fires an `AgentSessionEvent` webhook (`action: "created"`) to `POST /linear/webhook`.
3. The bridge verifies the webhook signature, retrieves the stored OAuth access token for the workspace, transitions the issue to **In Progress**, and creates a Manus task using the `promptContext` field (Linear's pre-formatted prompt containing the issue title, description, comments, and workspace guidance).
4. The Manus task ID is stored in memory alongside the Linear issue ID.
5. When Manus completes the task, it fires a callback to `POST /webhook/manus`. The bridge looks up the associated Linear issue and transitions it to **Done** (or **Cancelled** on failure), posting any output as a comment.

---

## Environment Variables

All variables must be set in your Railway service's **Variables** tab.

| Variable | Required | Description |
| :--- | :---: | :--- |
| `LINEAR_CLIENT_ID` | Yes | OAuth App Client ID from Linear → Settings → API → OAuth Applications |
| `LINEAR_CLIENT_SECRET` | Yes | OAuth App Client Secret from the same page |
| `LINEAR_REDIRECT_URI` | Yes | Must be `https://<your-domain>/oauth/callback` and match exactly what is registered in the Linear OAuth App settings |
| `LINEAR_WEBHOOK_SECRET` | Yes | The signing secret shown in Linear → Settings → API → Webhooks. Used to verify HMAC-SHA256 signatures on incoming Linear webhooks |
| `MANUS_API_KEY` | Yes | Your Manus API key (from the Manus dashboard) |
| `INSTALLATION_STORE_SECRET` | Yes | A random secret used to AES-256-GCM encrypt the OAuth token store on disk. Generate with `openssl rand -hex 32` |
| `SERVICE_BASE_URL` | Yes | Your production deployment URL with no trailing slash, e.g. `https://linear-manus-bridge-production.up.railway.app`. Used to reconstruct the full webhook URL for Manus RSA-SHA256 signature verification |
| `DATA_DIR` | Yes | Path to the persistent data directory. Must be set to the Railway Volume mount path (e.g. `/data`). See [Persistent Storage](#persistent-storage) below |
| `MANUS_API_URL` | No | Manus task creation endpoint. Defaults to `https://api.manus.im/v1/tasks` |
| `LINEAR_IN_PROGRESS_STATE` | No | Name of the Linear workflow state to set when a task starts. Defaults to `In Progress` |
| `LINEAR_COMPLETION_STATE` | No | Name of the Linear workflow state to set when a task completes. Defaults to `Done` |
| `LINEAR_FAILURE_STATE` | No | Name of the Linear workflow state to set when a task fails. Defaults to `Cancelled` |
| `LINEAR_NEEDS_INPUT_STATE` | No | Name of the Linear workflow state to set when Manus needs more information. Defaults to `Needs Input` |
| `MANUS_AGENT_PROFILE` | No | Manus agent profile to use. Defaults to `manus-1.6` |
| `MANUS_TASK_MODE` | No | Manus task mode. Defaults to `agent` |

---

## Persistent Storage

The bridge stores two files on disk that **must survive service restarts and redeployments**:

| File | Contents |
| :--- | :--- |
| `.installations.enc` | AES-256-GCM encrypted OAuth access tokens and refresh tokens, keyed by Linear workspace ID |
| `.oauth-states.json` | Short-lived CSRF state tokens used during the OAuth authorization flow (TTL: 10 minutes) |

Railway's default filesystem is **ephemeral** — it is wiped on every deployment. If these files are stored in the default working directory, the OAuth tokens are lost on every deploy, requiring a full re-authorization each time.

### Setting up a Railway Volume

1. In the Railway dashboard, open your service and go to **Settings → Volumes**.
2. Click **Add Volume** and set the **Mount Path** to `/data`.
3. In your service's **Variables**, add `DATA_DIR=/data`.
4. Redeploy the service. The volume is now mounted at `/data` and will persist across all future deployments and restarts.

**Important:** After adding the volume and redeploying, you must complete the OAuth installation flow once (see below). The tokens will then be written to `/data/.installations.enc` and will persist permanently.

---

## Deployment on Railway

### 1. Fork and connect the repository

Fork this repository and connect it to a new Railway service via **New Project → Deploy from GitHub repo**.

### 2. Set environment variables

Add all required variables from the table above in Railway → Variables.

### 3. Add a persistent Volume

Follow the [Persistent Storage](#persistent-storage) steps above before completing the OAuth flow.

### 4. Register the Manus webhook

Make this one-time API call to register your deployment URL with Manus:

```bash
curl --request POST \
  --url https://api.manus.ai/v1/webhooks \
  --header 'API_KEY: YOUR_MANUS_API_KEY' \
  --header 'Content-Type: application/json' \
  --data '{
    "webhook": {
      "url": "https://<your-domain>/webhook/manus"
    }
  }'
```

Save the returned `webhook_id` — you will need it to update or delete the webhook registration in future.

### 5. Register the Linear webhook

In **Linear → Settings → API → Webhooks**, create a new webhook:

- **URL:** `https://<your-domain>/linear/webhook`
- **Events:** Enable **Agent session events** only
- Copy the **Signing secret** and set it as `LINEAR_WEBHOOK_SECRET` in Railway

### 6. Complete the OAuth installation

Visit the install URL in a browser while logged in as a Linear workspace admin:

```
https://<your-domain>/oauth/install
```

You will be redirected to Linear to approve the permissions. After approving, Linear redirects back to your `/oauth/callback` endpoint. You should see a JSON response in your browser:

```json
{"ok": true, "installationId": "...", "workspaceId": "..."}
```

This confirms the OAuth tokens have been written to disk. Verify by visiting:

```
https://<your-domain>/oauth/installations
```

You should see `"count": 1` with your workspace listed as `"active": true`.

---

## Linear OAuth App Configuration

In **Linear → Settings → API → OAuth Applications**, your app must be configured as follows:

| Setting | Value |
| :--- | :--- |
| **Callback URL** | `https://<your-domain>/oauth/callback` |
| **Actor** | `app` (enables `actor=app` OAuth flow so the app acts as a workspace user) |
| **Scopes** | `read`, `write`, `app:assignable`, `app:mentionable` |

---

## Webhook Security

### Linear to Bridge (HMAC-SHA256)

Linear signs outgoing webhooks with HMAC-SHA256 using the signing secret configured in the webhook settings. The bridge verifies the `linear-signature` header against `LINEAR_WEBHOOK_SECRET`. If the secret is not set, verification is skipped (not recommended for production).

### Manus to Bridge (RSA-SHA256)

Manus signs outgoing webhooks with RSA-SHA256 using its own private key. The bridge fetches Manus's public key from `GET https://api.manus.ai/v1/webhook/public_key`, caches it for one hour, and verifies the `X-Webhook-Signature` header. The signed content is `{timestamp}.{full_webhook_url}.{sha256_hex_of_body}`. Timestamps older than 5 minutes are rejected to prevent replay attacks.

---

## Known Limitations

- **In-memory task store:** The mapping between Manus task IDs and Linear issue IDs is stored in memory only. If the service restarts while a Manus task is in flight (between webhook receipt and Manus callback), the bridge will lose track of which issue to update. For production use at scale, this should be replaced with a persistent store (e.g. Redis or a database).
- **Single workspace:** The current implementation supports one Linear workspace installation. Multi-workspace support would require iterating over all installations when routing Manus callbacks.
