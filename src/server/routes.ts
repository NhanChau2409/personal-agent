import { EventEncoder } from "@ag-ui/encoder";
import { RunAgentInputSchema } from "@ag-ui/core/schemas";
import type { FastifyInstance } from "fastify";
import type { PiAgUiAdapter } from "./agent.js";
import type { Config } from "./config.js";
import { createAccessVerifier } from "./auth.js";

export async function registerRoutes(app: FastifyInstance, config: Config, agent: PiAgUiAdapter) {
  const verifyAccess = createAccessVerifier(config);

  app.get("/healthz", async () => ({ status: "ok" }));

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
