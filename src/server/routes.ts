import { EventEncoder } from "@ag-ui/encoder";
import { RunAgentInputSchema } from "@ag-ui/core/schemas";
import type { FastifyInstance } from "fastify";
import type { PiAgUiAdapter } from "./agent.js";
import type { Config } from "./config.js";
import { createAccessVerifier } from "./auth.js";
import type { GoogleTasks } from "./google.js";
import { z } from "zod";

export async function registerRoutes(app: FastifyInstance, config: Config, agent: PiAgUiAdapter, google?: GoogleTasks) {
  const verifyAccess = createAccessVerifier(config);

  app.get("/healthz", async () => ({ status: "ok" }));

  // All Google endpoints, including the OAuth callback, require the owner's Access identity.
  app.get("/api/google/accounts", { preHandler: verifyAccess }, async () => ({ configured: !!google, accounts: google?.listAccounts() ?? [] }));
  app.get("/api/google/connect", { preHandler: verifyAccess }, async (_request, reply) => {
    if (!google) return reply.code(503).send({ error: "Google integration is not configured" });
    return reply.redirect(google.authorizeUrl());
  });
  app.get("/api/google/callback", { preHandler: verifyAccess }, async (request, reply) => {
    if (!google) return reply.code(503).send({ error: "Google integration is not configured" });
    const parsed = z.object({ state: z.string(), code: z.string() }).safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid authorization response" });
    try {
      await google.connect(parsed.data.state, parsed.data.code);
      return reply.header("cache-control", "no-store").redirect("/?tasks=connected");
    } catch (error) {
      request.log.warn({ message: (error as Error).message }, "Google account connection failed");
      return reply.code(400).send({ error: "Could not connect Google account. Please try again." });
    }
  });
  app.delete("/api/google/accounts/:id", { preHandler: verifyAccess }, async (request, reply) => {
    if (!google) return reply.code(503).send({ error: "Google integration is not configured" });
    const { id } = request.params as { id: string };
    try { await google.disconnect(id); return { ok: true }; }
    catch { return reply.code(404).send({ error: "Account not found" }); }
  });
  app.get("/api/tasks", { preHandler: verifyAccess }, async (request, reply) => {
    if (!google) return reply.code(503).send({ error: "Google integration is not configured" });
    const parsed = z.object({ cursor: z.string().max(8192).optional() }).safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid task cursor" });
    return reply.header("cache-control", "no-store").send(await google.overview(parsed.data.cursor));
  });
  const createTask = z.object({ account: z.string(), list: z.string(), title: z.string().trim().min(1).max(1024), due: z.iso.date().optional() });
  app.post("/api/tasks", { preHandler: verifyAccess }, async (request, reply) => {
    if (!google) return reply.code(503).send({ error: "Google integration is not configured" });
    const parsed = createTask.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid task" });
    try { return await google.create(parsed.data.account, parsed.data.list, parsed.data.title, parsed.data.due); }
    catch (error) { return reply.code(502).send({ error: (error as Error).message }); }
  });
  app.patch("/api/tasks/:task", { preHandler: verifyAccess }, async (request, reply) => {
    if (!google) return reply.code(503).send({ error: "Google integration is not configured" });
    const parsed = z.object({ account: z.string(), list: z.string(), title: z.string().trim().min(1).max(1024).optional(),
      status: z.enum(["completed", "needsAction"]).optional(), due: z.iso.date().nullable().optional() }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid task update" });
    const { account, list, ...changes } = parsed.data;
    try { return await google.update(account, list, (request.params as { task: string }).task, changes); }
    catch (error) { return reply.code(502).send({ error: (error as Error).message }); }
  });

  app.get("/api/calendar", { preHandler: verifyAccess }, async (request, reply) => {
    if (!google) return reply.code(503).send({ error: "Google integration is not configured" });
    const parsed = z.object({ timeMin: z.iso.datetime({ offset: true }), timeMax: z.iso.datetime({ offset: true }), cursor: z.string().max(8192).optional() }).safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid calendar range" });
    try { return reply.header("cache-control", "no-store").send(await google.events(parsed.data.timeMin, parsed.data.timeMax, parsed.data.cursor)); }
    catch (error) { return reply.code(502).send({ error: (error as Error).message }); }
  });
  app.post("/api/calendar/events", { preHandler: verifyAccess }, async (request, reply) => {
    if (!google) return reply.code(503).send({ error: "Google integration is not configured" });
    const parsed = z.object({ calendarId: z.string().optional(), summary: z.string().trim().min(1).max(1024),
      start: z.string(), end: z.string(), allDay: z.boolean().optional(), description: z.string().max(8192).optional() }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid calendar event" });
    try { return await google.createEvent(parsed.data); }
    catch (error) { return reply.code(502).send({ error: (error as Error).message }); }
  });
  app.get("/api/drive/files", { preHandler: verifyAccess }, async (request, reply) => {
    if (!google) return reply.code(503).send({ error: "Google integration is not configured" });
    const parsed = z.object({ q: z.string().max(200).optional(), cursor: z.string().max(2048).optional() }).safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid file search" });
    try { return reply.header("cache-control", "no-store").send(await google.files(parsed.data.q, parsed.data.cursor)); }
    catch (error) { return reply.code(502).send({ error: (error as Error).message }); }
  });
  app.post("/api/drive/documents", { preHandler: verifyAccess }, async (request, reply) => {
    if (!google) return reply.code(503).send({ error: "Google integration is not configured" });
    const parsed = z.object({ title: z.string().trim().min(1).max(255) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid document" });
    try { return await google.createDocument(parsed.data.title); }
    catch (error) { return reply.code(502).send({ error: (error as Error).message }); }
  });
  app.post("/api/drive/sheets", { preHandler: verifyAccess }, async (request, reply) => {
    if (!google) return reply.code(503).send({ error: "Google integration is not configured" });
    const parsed = z.object({ title: z.string().trim().min(1).max(255) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid spreadsheet" });
    try { return await google.createSheet(parsed.data.title); }
    catch (error) { return reply.code(502).send({ error: (error as Error).message }); }
  });
  app.get("/api/drive/documents/:id", { preHandler: verifyAccess }, async (request, reply) => {
    if (!google) return reply.code(503).send({ error: "Google integration is not configured" });
    try { return await google.readDocument((request.params as { id: string }).id); }
    catch (error) { return reply.code(502).send({ error: (error as Error).message }); }
  });
  app.get("/api/drive/sheets/:id", { preHandler: verifyAccess }, async (request, reply) => {
    if (!google) return reply.code(503).send({ error: "Google integration is not configured" });
    const range = z.object({ range: z.string().max(100).optional() }).safeParse(request.query);
    if (!range.success) return reply.code(400).send({ error: "Invalid range" });
    try { return await google.readSheet((request.params as { id: string }).id, range.data.range); }
    catch (error) { return reply.code(502).send({ error: (error as Error).message }); }
  });

  app.post("/api/agent", { preHandler: verifyAccess }, async (request, reply) => {
    const parsed = RunAgentInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "Invalid AG-UI request",
        issues: parsed.error.issues.map((issue) => ({ path: issue.path, message: issue.message }))
      });
    }
    if (agent.isRunning) return reply.code(409).send({ error: "Agent is busy" });

    const encoder = new EventEncoder({ accept: request.headers.accept });
    const abortController = new AbortController();
    const abort = () => abortController.abort();
    request.raw.once("aborted", abort);
    reply.raw.once("close", () => {
      if (!reply.raw.writableEnded) abort();
    });

    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": encoder.getContentType(),
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });

    try {
      await agent.run(
        parsed.data,
        (event) => {
          if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.write(encoder.encode(event));
        },
        abortController.signal
      );
    } catch (error) {
      request.log.error({ err: error }, "agent run failed");
    } finally {
      request.raw.off("aborted", abort);
      if (!reply.raw.writableEnded) reply.raw.end();
    }
  });
}
