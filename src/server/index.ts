import path from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { PiAgUiAdapter } from "./agent.js";
import { loadConfig } from "./config.js";
import { registerRoutes } from "./routes.js";

const config = loadConfig();
const app = Fastify({
  logger: {
    level: config.nodeEnv === "production" ? "info" : "debug",
    redact: ["req.headers.authorization", "req.headers.cookie", "req.headers.cf-access-jwt-assertion"]
  },
  bodyLimit: 256 * 1024
});
const agent = new PiAgUiAdapter(config);

await agent.initialize();
await registerRoutes(app, config, agent);

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.resolve(serverDir, "../client");
await app.register(fastifyStatic, {
  root: clientDir,
  wildcard: false,
  setHeaders(response, filePath) {
    const fileName = path.basename(filePath);
    if (fileName === "index.html" || fileName === "sw.js" || fileName === "manifest.webmanifest") {
      response.header("cache-control", "no-cache");
    } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
      response.header("cache-control", "public, max-age=31536000, immutable");
    } else {
      response.header("cache-control", "public, max-age=3600");
    }
  }
});

app.setNotFoundHandler((request, reply) => {
  if (request.url.startsWith("/api/")) return reply.code(404).send({ error: "Not found" });
  return reply.header("cache-control", "no-cache").sendFile("index.html");
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  await agent.dispose();
  await app.close();
  process.exit(0);
};
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: "0.0.0.0", port: config.port });
