# Personal Agent POC — Technical Architecture

## Status

Implementation architecture for the first private PWA. Application code may be built and tested locally. Changes under `../infra` require a separate review and must never be applied by an agent session.

## 1. System architecture

```text
iPhone PWA / macOS browser
          │
          │ HTTPS · agent.nhanchau.com
          ▼
Cloudflare edge
  ├── DNS
  ├── Access · Google OAuth + exact-email allow policy
  └── Tunnel
          │ outbound tunnel
          ▼
Hetzner Docker network
  ├── cloudflared
  └── personal-agent:3000
        ├── React PWA
        ├── assistant-ui
        ├── AG-UI endpoint
        ├── Pi 1.5 SDK
        └── OpenAI Codex subscription
```

The frontend and backend have one origin and one application container. Hetzner exposes no application port; `cloudflared` reaches the application through a private Compose network.

## 2. Foundation choices

| Layer | Choice | Reason |
|---|---|---|
| UI | assistant-ui | Maintained chat primitives, accessibility, markdown, branching/tool UI path |
| Agent/UI protocol | AG-UI 1.0 | Standard streaming, cancellation, tool, state, and human-interaction events |
| Frontend | React 19 + Vite | Supported by assistant-ui; small self-hosted build |
| Styling | assistant-ui registry components + Tailwind CSS | Customizable source-owned components without building primitives from scratch |
| PWA | vite-plugin-pwa | Manifest and service-worker generation |
| HTTP server | Fastify | Thin, typed Node server with streaming and static-file support |
| Agent harness | Pi SDK 1.5.0 | Codex OAuth, model runtime, session lifecycle, streaming |
| Authentication | Cloudflare Access + Google | No application password or user database |
| Origin connectivity | Cloudflare Tunnel | No inbound web ports on Hetzner |
| Deployment | Docker Compose | Observable one-person operation; no orchestrator required |

AG-UI is the contract between the browser and agent. Pi-specific translation is isolated in `src/server/agent.ts`, so a future UI or channel does not need to understand Pi events.

## 3. Application structure

```text
agents/
├── src/client/
│   ├── App.tsx                 # Application shell
│   ├── runtime.tsx             # assistant-ui AG-UI runtime
│   ├── main.tsx
│   └── styles.css
├── src/components/             # assistant-ui/shadcn source-owned components
├── src/server/
│   ├── index.ts                # Process lifecycle and static hosting
│   ├── config.ts               # Validated environment configuration
│   ├── auth.ts                 # Cloudflare Access JWT verification
│   ├── routes.ts               # Health and AG-UI endpoints
│   └── agent.ts                # AG-UI ↔ Pi adapter
├── public/                     # PWA icons
├── Dockerfile
├── compose.yaml
└── vite.config.ts
```

It remains one npm package and one application image. There is no database, Redis, queue, separate static host, or application authentication service.

## 4. Browser runtime

`@assistant-ui/react-ag-ui` supplies the runtime. It uses the official AG-UI `HttpAgent`:

```ts
const agent = new HttpAgent({ url: "/api/agent" });
const runtime = useAgUiRuntime({ agent, showThinking: false });
```

assistant-ui owns the current browser thread and sends the complete visible AG-UI message history with every run. The generated `Thread` component provides the transcript, composer, stop behavior, errors, markdown, and the extension points needed for future tools.

No provider or Pi credential reaches the browser.

### Current state lifetime

The browser thread is memory-only. Refreshing or closing the PWA clears the displayed conversation. This is intentional for the POC.

Future persistence will use an assistant-ui history/thread adapter backed by an application repository. AG-UI remains the transport; persistence does not require replacing the frontend.

## 5. HTTP API

### `GET /healthz`

Used by Docker health checks:

```json
{ "status": "ok" }
```

It does not contact Pi or Codex.

### `POST /api/agent`

The only agent endpoint. Request and response follow AG-UI 1.0.

Request is validated with `RunAgentInputSchema` and includes:

```json
{
  "threadId": "...",
  "runId": "...",
  "messages": [],
  "tools": [],
  "context": []
}
```

The response is streamed using `@ag-ui/encoder`. The basic sequence is:

```text
RUN_STARTED
TEXT_MESSAGE_START
TEXT_MESSAGE_CONTENT × n
TEXT_MESSAGE_END
RUN_FINISHED
```

Failure uses `RUN_ERROR`. Cancellation uses `RUN_FINISHED` with a `cancelled` outcome where the connection remains writable.

Response headers disable proxy buffering and transformation:

```http
Content-Type: text/event-stream
Cache-Control: no-cache, no-transform
X-Accel-Buffering: no
```

The server accepts one active run at a time. A concurrent run receives HTTP `409`.

## 6. Pi session lifecycle

The server creates one shared `ModelRuntime` at startup using the dedicated server credential directory. Each AG-UI run creates a fresh in-memory Pi session.

```text
AG-UI run
  ├── create SessionManager.inMemory()
  ├── append previous user/assistant messages
  ├── create Pi AgentSession with no tools
  ├── prompt with the newest user message
  ├── translate text_delta → AG-UI TEXT_MESSAGE_CONTENT
  └── dispose AgentSession
```

Using a fresh session per run has useful POC properties:

- the AG-UI request is the canonical conversation input;
- editing or branching in the browser sends the selected history;
- server and browser state cannot silently drift;
- no Pi session file is written;
- a failed process does not leave partial conversation state.

Pi 1.5 makes `SessionManager` authoritative for model context. History is appended to the manager before `createAgentSession()`; the application never mutates `session.agent.state.messages`.

### Message conversion

For the POC, only text user and assistant messages are converted. System, activity, reasoning, tool, image, audio, and file messages are not admitted into Pi history yet. Tools are disabled, so this is a deliberate capability boundary rather than silent partial tool support.

Historical assistant messages receive the configured model metadata and zero usage because the browser does not own provider accounting. New provider messages retain Pi's real metadata internally during the run.

### Model configuration

Initial configuration:

```text
provider: openai-codex
model:    gpt-6.1-sol
thinking: low
```

The model is explicit and validated at startup. The application does not silently choose another available model.

## 7. Pi resource and tool isolation

The web process uses a dedicated Pi agent directory and workspace. It does not use the operator's normal `~/.pi/agent` directory.

The session is created with:

```ts
noTools: "all"
SessionManager.inMemory()
```

It receives a fixed system prompt and no shell, filesystem, infrastructure, extension, MCP, or autonomous tools. The browser cannot configure the model, system prompt, working directory, or tool set.

Future personal tools must be explicit typed tools with narrow authority, reviewable input schemas, and human confirmation for side effects.

## 8. Streaming and cancellation flow

```text
assistant-ui        Fastify/AG-UI adapter       Pi SDK            Codex
     │ POST run               │                    │                │
     ├───────────────────────►│ validate JWT/body  │                │
     │                        │ create session     │                │
     │◄── RUN_STARTED ────────┤                    │                │
     │                        │ prompt()           │                │
     │                        ├───────────────────►│───────────────►│
     │◄── TEXT_* events ──────┤◄── text_delta ─────┤◄──────────────┤
     │◄── RUN_FINISHED ───────┤                    │                │
     │                        │ dispose session    │                │
```

When the user presses Stop, the AG-UI client aborts the HTTP request. The server's abort signal calls `session.abort()`. Pi cancellation and disposal are awaited before the adapter becomes available for another run.

## 9. Authentication and authorization

### Cloudflare Access

A self-hosted Access application protects:

```text
agent.nhanchau.com/*
```

Identity provider: Google OAuth.

Policy:

```text
Allow: exact owner Google email
Identity provider: Google
Default: deny
```

A 30-day Access session is appropriate initially for convenient PWA use.

### Application-side verification

Cloudflare sends:

```http
Cf-Access-Jwt-Assertion: <signed JWT>
```

Every `/api/*` request verifies:

- signature against the Access team's JWKS endpoint;
- issuer;
- application audience;
- expiry;
- exact owner email claim.

`/healthz` is exempt for private Docker health checks. Cloudflare Access still protects it from external requests.

The application has no users table, passwords, login endpoint, or session cookie of its own.

## 10. PWA behavior

The generated manifest uses standalone display mode and dedicated 192 px, 512 px, maskable, and Apple touch icons.

Service-worker policy:

- hashed frontend assets: precached;
- HTML navigation: network-first;
- `/api/*`: network-only;
- prompts and responses: never cached;
- no offline send queue.

Installation on iPhone uses Safari → Share → Add to Home Screen. The same origin works in a macOS browser.

## 11. Containers

### Build

The Dockerfile uses two stages:

1. Node 22 build stage installs the lockfile and compiles client/server;
2. Node 22 slim runtime installs production dependencies and runs as the non-root `node` user.

A push to `main` builds `linux/amd64` in GitHub Actions and publishes the private
`ghcr.io/nhanchau2409/personal-agent:main` image. A failed image build prevents
deployment. The restricted CI SSH key can invoke only the root-owned deployment
command, which pulls the image, recreates the application container, checks its
health, and logs out of GHCR. Hetzner does not build application source after
the CI transition.

### Compose

```text
personal-agent
  ├── internal port 3000
  ├── runtime app configuration
  └── dedicated Pi credential/workspace mounts

cloudflared
  ├── pinned image version
  ├── runtime tunnel token
  └── private route to personal-agent:3000
```

Compose does not publish port 3000 to the host.

## 12. Runtime filesystem

```text
/srv/apps/personal-agent/
├── source/                    # Git checkout
└── runtime/                   # never committed
    ├── app.env                # mode 0600
    ├── cloudflared.env        # mode 0600
    ├── pi-agent/              # mode 0700; OAuth credentials
    └── workspace/             # empty isolated Pi cwd
```

The Pi credential directory is writable because OAuth refresh may update it. It is the only Pi state mounted into the application container. The container does not mount the host home, Docker socket, SSH directory, or infrastructure repository.

## 13. Required environment

```dotenv
NODE_ENV=production
PORT=3000
AUTH_MODE=cloudflare
PUBLIC_ORIGIN=https://agent.nhanchau.com
OWNER_EMAIL=<owner-google-email>
CLOUDFLARE_ACCESS_TEAM_DOMAIN=<team>.cloudflareaccess.com
CLOUDFLARE_ACCESS_AUD=<access-application-audience>
PI_AGENT_DIR=/app/runtime/pi-agent
PI_CODING_AGENT_DIR=/app/runtime/pi-agent
PI_WORKSPACE=/app/runtime/workspace
PI_PROVIDER=openai-codex
PI_MODEL=gpt-6.1-sol
PI_THINKING=low
```

Cloudflared receives `TUNNEL_TOKEN` through its separate runtime environment file.

## 14. Infrastructure boundary

`../infra` remains authoritative for:

- Cloudflare Tunnel;
- tunnel hostname route;
- DNS record;
- Google identity provider where safely representable;
- Access application and exact-email policy;
- Hetzner server and SSH-only firewall;
- GitHub Actions variables, secrets, CI key, and restricted deployment bootstrap.

No inbound HTTP/HTTPS firewall rules are needed. Infrastructure changes are planned and validated with OpenTofu, then applied only by the owner. GHCR package visibility is outside the GitHub provider; the initial package remains private by default.

## 15. Operations from macOS

The owner accesses the VM through the existing SSH configuration:

```bash
ssh personal
ssh personal 'cd /srv/apps/personal-agent/source && docker compose ps'
ssh personal 'cd /srv/apps/personal-agent/source && docker compose logs --tail=100'
sftp personal
```

A remote editor may use SSH. SSHFS is optional, but Docker and deployment commands still run through SSH on the VM.

## 16. Evolution path

The architecture intentionally leaves stable seams:

1. **Persistence:** implement a thread repository and assistant-ui history adapter; keep AG-UI.
2. **Tasks/notes:** add application services and narrow Pi tools; do not expose general shell access.
3. **Approvals:** map Pi tool lifecycle to AG-UI tool and interrupt events.
4. **Notifications:** add a server-side scheduler and Web Push only when reminders are required.
5. **Additional channels:** build adapters against the same application services; keep the web PWA as the primary rich interface.
6. **Multiple agents:** introduce explicit agent profiles and authorization before adding orchestration.

Database, queues, schedulers, and additional channels are deferred until their requirements exist.

## 17. Validation gates

Before the CI transition:

```bash
npm run check
npm run build
npm audit --omit=dev
docker build .
```

After the transition, the push workflow's Docker build is the deployment gate. Production pulls the resulting GHCR image rather than compiling on the VM.

End-to-end acceptance:

- only the exact Google identity passes Access;
- API JWT verification rejects missing or invalid assertions;
- Hetzner has no public application port;
- AG-UI streams Pi output incrementally;
- Stop aborts the Pi run;
- editing/branching sends the selected AG-UI history;
- PWA installs and opens standalone on iPhone;
- the app works in macOS browsers;
- restart loses conversation as documented;
- secrets and conversation content are absent from Git, images, caches, and logs.
