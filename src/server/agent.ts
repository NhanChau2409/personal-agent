import { mkdir } from "node:fs/promises";
import type { BaseEvent, ContentPart, Message, RunAgentInput } from "@ag-ui/core";
import { EventType, PROTOCOL_VERSION } from "@ag-ui/core";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession
} from "@earendil-works/pi-coding-agent";
import type { Config } from "./config.js";

type EmitEvent = (event: BaseEvent) => void;

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
};

function textContent(message: Message): string {
  if (!("content" in message) || message.content == null) return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return (message.content as ContentPart[])
    .filter((part): part is Extract<ContentPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

export class PiAgUiAdapter {
  private modelRuntime?: ModelRuntime;
  private active?: { runId: string; session: AgentSession };

  constructor(private readonly config: Config) {}

  async initialize(): Promise<void> {
    await mkdir(this.config.piAgentDir, { recursive: true });
    await mkdir(this.config.workspace, { recursive: true });
    this.modelRuntime = await ModelRuntime.create({
      authPath: `${this.config.piAgentDir}/auth.json`,
      modelsPath: `${this.config.piAgentDir}/models.json`
    });

    const model = this.modelRuntime.getModel(this.config.piProvider, this.config.piModel);
    if (!model) throw new Error(`Pi model not found: ${this.config.piProvider}/${this.config.piModel}`);
  }

  get isRunning(): boolean {
    return this.active !== undefined;
  }

  private async createSession(input: RunAgentInput): Promise<AgentSession> {
    if (!this.modelRuntime) throw new Error("Pi adapter is not initialized");
    const model = this.modelRuntime.getModel(this.config.piProvider, this.config.piModel);
    if (!model) throw new Error(`Pi model not found: ${this.config.piProvider}/${this.config.piModel}`);

    const sessionManager = SessionManager.inMemory(this.config.workspace);
    const lastUserIndex = input.messages.findLastIndex((message) => message.role === "user");
    for (const message of input.messages.slice(0, lastUserIndex)) {
      const content = textContent(message);
      if (!content) continue;
      if (message.role === "user") {
        sessionManager.appendMessage({ role: "user", content, timestamp: Date.now() });
      } else if (message.role === "assistant") {
        sessionManager.appendMessage({
          role: "assistant",
          content: [{ type: "text", text: content }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: EMPTY_USAGE,
          stopReason: "stop",
          timestamp: Date.now()
        });
      }
    }

    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 2 }
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: this.config.workspace,
      agentDir: this.config.piAgentDir,
      settingsManager,
      systemPromptOverride: () =>
        "You are Nhan's concise personal assistant. Answer the current request directly. " +
        "You have no external tools and must not claim that you changed files or systems."
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      cwd: this.config.workspace,
      agentDir: this.config.piAgentDir,
      model,
      modelRuntime: this.modelRuntime,
      thinkingLevel: this.config.piThinking as "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
      noTools: "all",
      resourceLoader,
      settingsManager,
      sessionManager
    });
    return session;
  }

  async run(input: RunAgentInput, emit: EmitEvent, signal: AbortSignal): Promise<void> {
    if (this.active) throw new Error("Another agent run is already active");

    const latestUser = input.messages.findLast((message) => message.role === "user");
    const prompt = latestUser ? textContent(latestUser) : "";
    if (!prompt.trim()) throw new Error("The run does not contain a text user message");

    const session = await this.createSession(input);
    this.active = { runId: input.runId, session };
    const messageId = crypto.randomUUID();
    let messageStarted = false;
    let aborted = signal.aborted;

    const onAbort = () => {
      aborted = true;
      void session.abort();
    };
    signal.addEventListener("abort", onAbort, { once: true });

    const unsubscribe = session.subscribe((event) => {
      if (event.type !== "message_update" || event.assistantMessageEvent.type !== "text_delta") return;
      const delta = event.assistantMessageEvent.delta;
      if (!delta) return;
      if (!messageStarted) {
        messageStarted = true;
        emit({ type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" });
      }
      emit({ type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta });
    });

    emit({
      type: EventType.RUN_STARTED,
      threadId: input.threadId,
      runId: input.runId,
      protocolVersion: PROTOCOL_VERSION
    });

    try {
      await session.prompt(prompt);
      if (!messageStarted) {
        emit({ type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" });
      }
      emit({ type: EventType.TEXT_MESSAGE_END, messageId });
      emit({
        type: EventType.RUN_FINISHED,
        threadId: input.threadId,
        runId: input.runId,
        outcome: { type: aborted ? "cancelled" : "success" }
      });
    } catch (error) {
      if (messageStarted) emit({ type: EventType.TEXT_MESSAGE_END, messageId });
      emit({
        type: EventType.RUN_ERROR,
        message: aborted ? "Run cancelled" : "Agent run failed"
      });
      if (!aborted) throw error;
    } finally {
      signal.removeEventListener("abort", onAbort);
      unsubscribe();
      session.dispose();
      if (this.active?.runId === input.runId) this.active = undefined;
    }
  }

  async dispose(): Promise<void> {
    await this.active?.session.abort();
    this.active?.session.dispose();
    this.active = undefined;
  }
}
