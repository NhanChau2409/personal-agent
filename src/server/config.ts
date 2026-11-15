import path from "node:path";

export type Config = ReturnType<typeof loadConfig>;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function loadConfig() {
  const nodeEnv = process.env.NODE_ENV ?? "development";
  const authMode = process.env.AUTH_MODE ?? (nodeEnv === "production" ? "cloudflare" : "disabled");
  if (authMode !== "disabled" && authMode !== "cloudflare") {
    throw new Error("AUTH_MODE must be disabled or cloudflare");
  }
  if (nodeEnv === "production" && authMode === "disabled") {
    throw new Error("AUTH_MODE=disabled is forbidden in production");
  }

  const cloudflare = authMode === "cloudflare" ? {
    teamDomain: required("CLOUDFLARE_ACCESS_TEAM_DOMAIN").replace(/^https?:\/\//, "").replace(/\/$/, ""),
    audience: required("CLOUDFLARE_ACCESS_AUD"),
    ownerEmail: required("OWNER_EMAIL").toLowerCase()
  } : undefined;

  const googleSettings = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_TOKEN_KEY"].filter((name) => !!process.env[name]);
  if (googleSettings.length && googleSettings.length !== 3) {
    throw new Error("Google Tasks requires GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_TOKEN_KEY together");
  }

  return {
    nodeEnv,
    authMode,
    cloudflare,
    port: Number(process.env.PORT ?? 3000),
    publicOrigin: process.env.PUBLIC_ORIGIN ?? "http://127.0.0.1:3000",
    piAgentDir: path.resolve(process.env.PI_AGENT_DIR ?? "./runtime/pi-agent"),
    piProvider: process.env.PI_PROVIDER ?? "openai-codex",
    piModel: process.env.PI_MODEL ?? "gpt-6.1-sol",
    piThinking: process.env.PI_THINKING ?? "low",
    workspace: path.resolve(process.env.PI_WORKSPACE ?? "./runtime/workspace"),
    google: process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_TOKEN_KEY
      ? { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET,
          tokenKey: process.env.GOOGLE_TOKEN_KEY,
          store: path.resolve(process.env.GOOGLE_TOKEN_STORE ?? "./runtime/pi-agent/google-accounts.json") }
      : undefined,
    braveApiKey: process.env.BRAVE_API_KEY || undefined
  };
}
