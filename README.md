# Linear-Manus Bridge

A middleware service that bridges [Linear](https://linear.app) issues with [Manus](https://manus.im) AI agents. It automates task delegation, provides real-time progress updates via Linear's Agent Session API, and handles multi-turn interactions for clarifying questions.

## 🚀 Key Features

- **Automated Delegation**: Trigger Manus tasks by assigning issues to a "Manus" user or via Linear's native Agent Session events.
- **Real-time Progress**: Forwards Manus "thoughts" and "actions" directly to the Linear issue sidebar using the Agent Activity API.
- **Interactive Multi-turn**: When Manus asks a question ("ask" stop reason), the bridge posts it as a Linear comment. Replying to that comment forwards the answer back to Manus.
- **Rich Context**: Automatically extracts URLs and supports `manus-base64` Markdown blocks for file attachments.
- **Smart Fallbacks**: Automatically falls back to `manus-1.6-lite` if the preferred profile encounters credit limits.
- **Secure & Robust**: HMAC-SHA256 verification for Linear webhooks, RSA-SHA256 for Manus, and AES-256-GCM encryption for OAuth tokens at rest.

---

## 🛠️ Installation & Setup

### 1. Prerequisites

- A Linear Workspace with Admin access.
- A Manus API Key from the [Manus Dashboard](https://manus.im).
- A publicly accessible URL for your bridge (e.g., via [Railway](https://railway.app), [Render](https://render.com), or [ngrok](https://ngrok.com)).

### 2. Linear OAuth App Configuration

1.  Go to **Linear Settings** > **API** > **Applications**.
2.  Create a new application:
    - **Name**: `Manus Bridge` (or preferred).
    - **Callback URLs**: `https://<your-domain>/oauth/callback`.
3.  Note your **Client ID** and **Client Secret**.

### 3. Deployment

#### Option A: Node.js (local/server)

1.  Clone this repository.
2.  Copy `env.example` to `.env` and fill in the required variables (see [Environment Variables](#-environment-variables)).
3.  Ensure `DATA_DIR` points to a persistent volume or directory that survives restarts.
4.  Install dependencies and build:
    ```bash
    npm install
    npm run build
    ```
5.  Start the server:
    ```bash
    npm start
    ```

#### Option B: Docker

```bash
# Build the image
docker build -t linear-manus-bridge .

# Run with environment variables
docker run -d -p 3000:3000 \
  -e LINEAR_CLIENT_ID=your-client-id \
  -e LINEAR_CLIENT_SECRET=your-client-secret \
  -e LINEAR_REDIRECT_URI=https://your-domain/oauth/callback \
  -e LINEAR_WEBHOOK_SECRET=your-webhook-secret \
  -e MANUS_API_KEY=your-manus-api-key \
  -e INSTALLATION_STORE_SECRET=your-encryption-secret \
  -e SERVICE_BASE_URL=https://your-domain \
  -e DATA_DIR=/data \
  -v /path/to/data:/data \
  linear-manus-bridge
```

> **Tip**: On Linux, you may need to add `--user 1000` if you encounter permission issues with the data directory.

### 4. Workflow Setup (Optional)

For automatic state transitions, create these states in your Linear workflow and configure the corresponding env vars:

- **Completed**: Tasks that finished successfully (default: `Done`)
- **In Progress**: Tasks currently being worked on (default: `In Progress`)
- **Needs Input**: Tasks waiting for user clarification (default: `Needs Input`)
- **Cancelled**: Tasks that failed or were canceled (default: `Cancelled`)

### 4. Finalizing Integration

1.  **Authorize**: Visit `https://<your-domain>/oauth/install` and follow the OAuth flow.
2.  **Verify**: Check `https://<your-domain>/oauth/installations` to see your active workspace.
3.  **Webhook**: The bridge automatically registers its webhook with Manus on startup using `SERVICE_BASE_URL`. For Linear, configure a webhook in Linear Settings pointing to `https://<your-domain>/linear/webhook` with `Agent session events` enabled.

---

## ⚙️ Environment Variables

| Variable                    | Required | Description                                                                                                                               |
| :-------------------------- | :------: | :---------------------------------------------------------------------------------------------------------------------------------------- |
| `LINEAR_CLIENT_ID`          |   Yes    | OAuth App Client ID.                                                                                                                      |
| `LINEAR_CLIENT_SECRET`      |   Yes    | OAuth App Client Secret.                                                                                                                  |
| `LINEAR_REDIRECT_URI`       |   Yes    | Registered callback URL (e.g., `https://<your-domain>/oauth/callback`).                                                                   |
| `LINEAR_WEBHOOK_SECRET`     |   Yes    | Signing secret for Linear webhooks.                                                                                                       |
| `MANUS_API_KEY`             |   Yes    | Your API key from the Manus Dashboard.                                                                                                    |
| `INSTALLATION_STORE_SECRET` |   Yes    | A strong secret for AES-256-GCM encryption of tokens at rest.                                                                             |
| `SERVICE_BASE_URL`          |   Yes    | The public URL of your service (no trailing slash).                                                                                       |
| `DATA_DIR`                  |   Yes    | Path for persisting task state, OAuth tokens, and webhooks. Ensure this points to persistent storage (e.g., Docker volume, mounted disk). |
| `MANUS_API_URL`             |    No    | Base URL for Manus API. Defaults to `https://api.manus.im/v1/tasks`.                                                                      |
| `MANUS_AGENT_PROFILE`       |    No    | Default profile (`manus-1.6`, `manus-1.6-max`). Default: `manus-1.6`.                                                                     |
| `LINEAR_COMPLETION_STATE`   |    No    | Workflow state for finished tasks. Default: `Done`.                                                                                       |
| `LINEAR_NEEDS_INPUT_STATE`  |    No    | Workflow state when Manus asks a question. Default: `Needs Input`.                                                                        |

---

## 📂 Project Structure

```text
├── src/
│   ├── routes/          # Express handlers (Linear, Manus, OAuth)
│   ├── services/        # Logic (API clients, Auth, Storage, Webhooks)
│   ├── __tests__/       # Vitest suite
│   └── index.ts         # Entry point & app setup
├── env.example          # Environment template
├── package.json         # Scripts & dependencies
└── tsconfig.json        # TS configuration
```

---

## 📝 Usage Guide

### 📎 Attachments

The bridge handles context intelligently:

- **Auto-URLs**: Links in descriptions/comments are passed to Manus as URL attachments.
- **Base64 Files**: Embed files directly in Linear using this block:

  ````markdown
  ```manus-base64 filename=report.pdf mime=application/pdf
  <base64_content>
  ```
  ````

  ```

  ```

### 🤖 Profile Selection

Specify a Manus profile by adding a comment to the Linear issue:

- `/manus profile=manus-1.6-max`
- `/manus profile=manus-1.6-lite`

### 💬 Multi-turn Interaction

If Manus needs clarification, it will post a comment in Linear. Simply **reply to that specific comment**, and the bridge will forward your response back to the active Manus task.

---

## 🔐 Security

- **Signature Verification**: Validates all incoming webhooks (HMAC for Linear, RSA for Manus).
- **Token Safety**: OAuth tokens are encrypted before being written to disk.
- **Least Privilege**: Uses specific OAuth scopes (`read`, `write`, `app:assignable`, `app:mentionable`).

---

## 🤝 Contributing

1. Fork the Project.
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`).
3. Commit your Changes (`git commit -m 'Add some AmazingFeature'`).
4. Push to the Branch (`git push origin feature/AmazingFeature`).
5. Open a Pull Request.

---

## References

- [Linear Agent Documentation](https://linear.app/developers/agents)
- [Manus API Reference](https://open.manus.im/docs/api-reference)
