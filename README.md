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
