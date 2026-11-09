import type { FastifyReply, FastifyRequest } from "fastify";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Config } from "./config.js";

export function createAccessVerifier(config: Config) {
  if (!config.cloudflare) return async () => undefined;

  const { teamDomain, audience, ownerEmail } = config.cloudflare;
  const issuer = `https://${teamDomain}`;
  const keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));

  return async function verifyAccess(request: FastifyRequest, reply: FastifyReply) {
    const assertion = request.headers["cf-access-jwt-assertion"];
    if (typeof assertion !== "string") {
      return reply.code(401).send({ error: "Authentication required" });
    }

    try {
      const { payload } = await jwtVerify(assertion, keys, { issuer, audience });
      if (typeof payload.email !== "string" || payload.email.toLowerCase() !== ownerEmail) {
        return reply.code(403).send({ error: "Access denied" });
      }
    } catch {
      return reply.code(401).send({ error: "Invalid authentication" });
    }
  };
}
