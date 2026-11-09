# Personal Agent

This repository contains a minimal private PWA backed by the Pi SDK.

- Keep one TypeScript application and one application container.
- Keep the frontend and API on the same origin.
- Do not add persistence, queues, extra channels, or autonomous tools without an explicit requirement.
- The web-facing Pi session must not receive shell or filesystem tools.
- Never commit OAuth credentials, Cloudflare secrets, runtime files, conversations, or `.env` files.
- Infrastructure lives in `../infra`; never apply infrastructure changes from an agent session.

Validation:

```bash
npm run check
npm run build
docker build .
```
