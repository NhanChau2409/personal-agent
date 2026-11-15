# Personal Agent POC

Private installable web chat backed by Pi and a Codex subscription.

```text
assistant-ui PWA → AG-UI → Pi SDK → OpenAI Codex
```

Cloudflare Access authenticates the owner with Google; Cloudflare Tunnel connects the public hostname to the application container without exposing a Hetzner web port.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the technical design.

## Validate

```bash
npm install
npm run check
npm run build
npm audit --omit=dev
docker build .
```

## Local shell test

A server can start without model credentials for health and UI checks:

```bash
NODE_ENV=development \
AUTH_MODE=disabled \
PI_AGENT_DIR=/tmp/personal-agent/pi \
PI_WORKSPACE=/tmp/personal-agent/workspace \
npm start
```

Authentication is deliberately forbidden from being disabled when `NODE_ENV=production`.

## Server runtime

Runtime state lives outside the source checkout:

```text
/srv/apps/personal-agent/runtime/
├── app.env
├── cloudflared.env
├── pi-agent/
└── workspace/
```

Create directories for the container's non-root UID before the first start:

```bash
sudo install -d -m 700 -o 1000 -g 1000 \
  /srv/apps/personal-agent/runtime/pi-agent \
  /srv/apps/personal-agent/runtime/workspace
```

Copy `.env.example` to the uncommitted runtime `app.env` and replace placeholders with reviewed Cloudflare outputs. Store only this in `cloudflared.env`:

```dotenv
TUNNEL_TOKEN=<secret output from OpenTofu>
```

## Codex login

The deployment uses a dedicated Pi credential directory rather than the operator's normal Pi configuration. After the image and runtime files exist:

```bash
docker compose run --rm --no-deps personal-agent \
  ./node_modules/.bin/pi
```

Inside Pi, run `/login` and choose OpenAI Codex. On a headless server, complete authentication in the Mac browser and paste the final redirect URL or authorization code back into Pi when prompted.

The runtime environment must set both paths to the same mounted directory:

```dotenv
PI_AGENT_DIR=/app/runtime/pi-agent
PI_CODING_AGENT_DIR=/app/runtime/pi-agent
```

`PI_AGENT_DIR` is consumed by this application. `PI_CODING_AGENT_DIR` is consumed by the Pi CLI during login. Never commit `auth.json`, copy it into an image, or print it.

## Google Tasks and Brave Search (optional)

The app has a combined Google Tasks panel (desktop sidebar, iPhone sheet). The agent uses the same Tasks service through three narrow tools: read, create and update. Task changes are immediate; no bulk plan or reordering tool is exposed. The panel polls for changes every 60 seconds while visible. Calendar, Drive, chat synchronization and Daily/Effort mode controls are **not** included yet.

Create a **new Google OAuth web client** for Tasks (do not reuse Cloudflare Access's login client). Set the authorized redirect URI to `https://agent.nhanchau.com/api/google/callback`; configure the OAuth consent screen with the Google Tasks API enabled and the `https://www.googleapis.com/auth/tasks` scope. For a testing-mode consent screen add each Google account as a test user; Google may expire testing-mode refresh tokens after 7 days. Publishing an external app with sensitive scopes may require Google verification. Connect each account via **Connect Google account** in the Tasks panel while signed into the app as the owner. This is authorization of data, not a second app login; each account is labeled and writes target the chosen account. Only connect accounts you control or have permission to manage.

Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_TOKEN_KEY` in the private runtime `app.env`. Generate the key with `openssl rand -base64 32` and keep a secure backup: it encrypts the account refresh tokens in the mounted `pi-agent/google-accounts.json`. Do not rotate it without reconnecting accounts. Leave these variables unset to disable the integration. `PUBLIC_ORIGIN` must match the HTTPS hostname. Do not commit or print the credentials or token file.

For Brave web search, obtain a **Brave Search API key** (consumer Brave/YouTube Premium does not include this API), then set `BRAVE_API_KEY` in `app.env`. The app uses Brave's official MCP server with **only** `brave_web_search` exposed to Pi; it never exposes shell or filesystem tools. Without the key search remains disabled.

## Delivery

A push to `main` builds `linux/amd64`, publishes the private image
`ghcr.io/nhanchau2409/personal-agent:main`, and deploys it through a restricted
CI-only SSH key. A failed image build stops the workflow before deployment.
Hetzner pulls the image and recreates only the application container; runtime
credentials and workspace data remain in host bind mounts.

The GitHub Actions secret and variables are managed by `infra/github` in the
separate infrastructure repository. New GHCR packages default to private.

For a local image build with OrbStack:

```bash
docker compose -f compose.yaml -f compose.local.yaml build personal-agent
```

Production operations on Hetzner:

```bash
RUNTIME_DIR=/srv/apps/personal-agent/runtime docker compose pull personal-agent
RUNTIME_DIR=/srv/apps/personal-agent/runtime docker compose up -d --no-deps personal-agent
RUNTIME_DIR=/srv/apps/personal-agent/runtime docker compose ps
RUNTIME_DIR=/srv/apps/personal-agent/runtime docker compose logs --tail=100 personal-agent
```

Deployment and live infrastructure changes are owner-operated. Agents may validate and plan but must not apply them or push deployment-triggering commits.
