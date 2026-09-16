/**
 * One public `live/sessions` session backed by a Codex realtime thread.
 *
 * Audio flows directly between the client and OpenAI over WebRTC. The proxy only
 * exchanges the SDP offer/answer, receives transcripts and control notifications
 * over JSON-RPC, and drives the session through `thread/realtime/*` requests.
 */
import { randomBytes } from "node:crypto";
import type { WebSocket } from "ws";
import { CODEX_EXITED, CodexClient } from "./codex.ts";
import type { ProxyConfig } from "./config.ts";
import type { Logger } from "./log.ts";
import {
  ackEvent, APP_CONTEXT_PREFIX, APP_INSTRUCTION_PREFIX, buildPrompt, chooseVoice, delegationCompletedEvent, errorEvent, eventID,
  handoffInstructions, handoffRequest, historyToInitialItems, planCommand, translateNotification, usageEvent, type JsonObject, type PublicEvent,
} from "./translate.ts";

export type SessionState = "connecting" | "active" | "closing" | "closed";

export interface LiveSessionRequest {
  instructions: string;
  voice: unknown;
  input: unknown;
  model: string | null;
  sdp: string;
}

export interface LiveSessionDeps {
  config: ProxyConfig;
  codex: CodexClient;
  logger: Logger;
  supportedVoices: string[];
  onClosed: (session: LiveSession) => void;
}

const MAX_COMMAND_CHARS = 4_000;
const MAX_THINKING_ENTRIES = 12;
const USAGE_INTERVAL_MS = 15_000;
const BUFFER_LIMIT = 2_000;

export class LiveSession {
  readonly id = "sess_" + randomBytes(12).toString("base64url");
  readonly createdAt = Date.now();
  private readonly deps: LiveSessionDeps;
  private readonly logger: Logger;
  threadID: string | null = null;
  state: SessionState = "connecting";
  model: string;
  voice = "";
  voiceSubstituted = false;
  requestedVoice: string | null = null;
  closeReason: string | null = null;
  private activeAt: number | null = null;
  private buffer: PublicEvent[] = [];
  private client: WebSocket | null = null;
  private thinking: string[] = [];
  private lastTranscriptAt = 0;
  private unsubscribe: (() => void) | null = null;
  private timers = new Set<NodeJS.Timeout>();
  private usageTicker: NodeJS.Timeout | null = null;
  private graceTimer: NodeJS.Timeout | null = null;
  private quietTimer: NodeJS.Timeout | null = null;
  private sdpWaiters: { resolve: (sdp: string) => void; reject: (error: Error) => void } | null = null;
  private closedNotified = false;
  private commandQueue: Promise<void> = Promise.resolve();
  /** Handoff announced by the live model but whose agent turn has not started yet. */
  private pendingHandoff: { id: string; at: number } | null = null;
  /** Agent turns currently answering a handoff, by Codex turn id. */
  private handoffTurns = new Map<string, { id: string; startedAt: number; searches: number }>();

  constructor(deps: LiveSessionDeps) {
    this.deps = deps;
    this.logger = deps.logger.child(this.id.slice(0, 12));
    this.model = deps.config.liveModel;
  }

  get elapsedMs(): number {
    return Date.now() - (this.activeAt ?? this.createdAt);
  }

  get usageSeconds(): number {
    return Math.round(this.elapsedMs / 1000);
  }

  toJSON(): JsonObject {
    return {
      id: this.id,
      object: "live.session",
      model: this.model,
      status: this.state,
      voice: this.voice,
      requested_voice: this.requestedVoice,
      voice_substituted: this.voiceSubstituted,
      created_at: Math.floor(this.createdAt / 1000),
      expires_at: Math.floor((this.createdAt + this.deps.config.maxSessionMinutes * 60_000) / 1000),
      usage: { seconds: this.usageSeconds },
      close_reason: this.closeReason,
    };
  }

  /** Creates the Codex thread, negotiates WebRTC and returns the SDP answer. */
  async start(request: LiveSessionRequest): Promise<string> {
    const { codex, config } = this.deps;
    await codex.ensure();
    // The thread's model and instructions serve the agent that answers the live model's handoffs.
    const thread = await codex.request<JsonObject>("thread/start", {
      cwd: config.dataDir,
      ephemeral: true,
      approvalPolicy: "never",
      sandbox: "read-only",
      model: config.textModel,
      baseInstructions: handoffInstructions(request.instructions),
      config: { "features.realtime_conversation": true, web_search: "live", model_reasoning_effort: config.textEffort },
    }, 30_000);
    const threadID = ((thread["thread"] ?? {}) as JsonObject)["id"];
    if (typeof threadID !== "string") throw new Error("Codex did not return a thread id.");
    this.threadID = threadID;
    this.unsubscribe = codex.subscribe(threadID, (method, params) => this.onNotification(method, params));

    const chosen = chooseVoice(request.voice, this.deps.supportedVoices, config.defaultVoice);
    this.voice = chosen.voice;
    this.voiceSubstituted = chosen.substituted;
    this.requestedVoice = typeof request.voice === "string" ? request.voice : null;
    if (chosen.substituted) this.logger.info("voice not available on Codex, substituted", { requested: request.voice, voice: chosen.voice });
    if (request.model && request.model !== config.liveModel) this.logger.debug("live model mapped", { requested: request.model, model: config.liveModel });

    const params: JsonObject = {
      threadId: threadID,
      version: "v3",
      model: config.liveModel,
      outputModality: "audio",
      includeStartupContext: false,
      // Codex runs the handoff turn and hands the answer back itself. With client-managed handoffs
      // the answer never reaches the live model, which says "let me check" and then stays silent.
      clientManagedHandoffs: false,
      codexResponseHandoffMode: config.handoffMode,
      prompt: buildPrompt(request.instructions),
      voice: chosen.voice,
      transport: { type: "webrtc", sdp: request.sdp },
    };
    const history = historyToInitialItems(request.input);
    if (history.length) params["initialItems"] = history;

    const answer = new Promise<string>((resolve, reject) => { this.sdpWaiters = { resolve, reject }; });
    const guard = this.after(30_000, () => this.sdpWaiters?.reject(new Error("Codex did not return an SDP answer within 30 seconds.")));
    try {
      await codex.request("thread/realtime/start", params, 30_000);
      const sdp = await answer;
      this.armGrace("no client attached after start");
      this.startTimers();
      return sdp;
    } catch (error) {
      await this.close("start_failed", error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      clearTimeout(guard);
      this.sdpWaiters = null;
    }
  }

  private after(ms: number, fn: () => void): NodeJS.Timeout {
    const timer = setTimeout(() => { this.timers.delete(timer); fn(); }, ms);
    this.timers.add(timer);
    return timer;
  }

  private startTimers() {
    this.after(this.deps.config.maxSessionMinutes * 60_000, () => {
      this.emit(errorEvent("The session reached the proxy's maximum duration.", undefined, "session_timeout"));
      void this.close("max_duration");
    });
    this.usageTicker = setInterval(() => { if (this.state === "active") this.emit(usageEvent(this.elapsedMs)); }, USAGE_INTERVAL_MS);
  }

  private armGrace(reason: string) {
    this.clearGrace();
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      if (this.client) return;
      this.logger.warn("closing session without a client", { reason });
      void this.close("client_absent");
    }, this.deps.config.clientGraceSeconds * 1_000);
  }

  private clearGrace() {
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = null;
  }

  private onNotification(method: string, params: JsonObject) {
    if (method !== "thread/realtime/outputAudio/delta") this.logger.debug("notification", { method, role: params["role"], text: typeof params["delta"] === "string" ? params["delta"] : typeof params["text"] === "string" ? params["text"].slice(0, 60) : undefined, message: params["message"], reason: params["reason"] });
    if (method === CODEX_EXITED) {
      this.emit(errorEvent("Codex exited on the proxy machine. The voice session has ended.", undefined, "codex_exited"));
      this.finishClosed("codex_exited");
      return;
    }
    if (method === "thread/realtime/sdp" && typeof params["sdp"] === "string") {
      this.sdpWaiters?.resolve(params["sdp"]);
      return;
    }
    if (method === "thread/realtime/error" && this.sdpWaiters) {
      this.sdpWaiters.reject(new Error(typeof params["message"] === "string" ? params["message"] : "Codex could not start the voice session."));
    }
    if (method === "thread/realtime/started" && this.state === "connecting") {
      this.state = "active";
      this.activeAt = Date.now();
      this.lastTranscriptAt = Date.now();
    }
    if (method === "thread/realtime/transcript/delta" || method === "thread/realtime/transcript/done") {
      this.lastTranscriptAt = Date.now();
      this.scheduleQuietFlush();
    }
    this.trackHandoff(method, params);
    for (const event of translateNotification(method, params, this.id, this.elapsedMs)) {
      if (event.type === "session.closed") {
        this.closeReason = this.closeReason ?? (typeof params["reason"] === "string" ? params["reason"] : null);
        this.emit(event);
        this.finishClosed(this.closeReason ?? "closed");
        continue;
      }
      this.emit(event);
    }
    if (method === "thread/realtime/error" && this.state === "active") {
      void this.close("realtime_error");
    }
  }

  /**
   * Follows a handoff from the live model's `handoff_request` item through the agent turn Codex
   * starts for it, and tells the client when that turn is over.
   */
  private trackHandoff(method: string, params: JsonObject) {
    const turn = (params["turn"] ?? {}) as JsonObject;
    const turnID = typeof turn["id"] === "string" ? turn["id"] : null;
    switch (method) {
      case "thread/realtime/itemAdded": {
        const handoff = handoffRequest(params);
        if (!handoff) return;
        this.pendingHandoff = { id: handoff.id, at: Date.now() };
        this.logger.info("handoff requested", { id: handoff.id, input: handoff.input.slice(0, 80) });
        return;
      }
      case "turn/started": {
        if (!turnID) return;
        const pending = this.pendingHandoff;
        this.pendingHandoff = null;
        this.handoffTurns.set(turnID, { id: pending?.id ?? turnID, startedAt: pending?.at ?? Date.now(), searches: 0 });
        return;
      }
      case "item/completed": {
        const item = (params["item"] ?? {}) as JsonObject;
        const owner = typeof params["turnId"] === "string" ? this.handoffTurns.get(params["turnId"]) : undefined;
        if (owner && item["type"] === "webSearch") owner.searches += 1;
        return;
      }
      case "turn/completed": {
        if (!turnID) return;
        const handoff = this.handoffTurns.get(turnID);
        if (!handoff) return;
        this.handoffTurns.delete(turnID);
        const status = turn["status"] === "completed" ? "completed" : "failed";
        this.logger.info("handoff answered", { id: handoff.id, status, seconds: Math.round((Date.now() - handoff.startedAt) / 100) / 10, searches: handoff.searches });
        this.emit(delegationCompletedEvent(handoff.id, status, handoff.searches));
        return;
      }
      default:
        return;
    }
  }

  // ---- WebSocket client -------------------------------------------------------------

  attach(ws: WebSocket) {
    if (this.client && this.client !== ws) {
      try { this.client.close(4000, "Replaced by a newer events connection."); } catch { /* already closed */ }
    }
    this.client = ws;
    this.clearGrace();
    this.logger.info("events client attached", { buffered: this.buffer.length });
    for (const event of this.buffer) this.sendToClient(event);
    this.buffer = [];
    ws.on("message", (data) => { this.commandQueue = this.commandQueue.then(() => this.handleCommand(data.toString())).catch(() => undefined); });
    ws.on("close", () => {
      if (this.client !== ws) return;
      this.client = null;
      if (this.state === "closed") return;
      this.logger.info("events client detached");
      this.armGrace("client disconnected");
    });
    ws.on("error", (error) => this.logger.debug("client socket error", { error: String(error) }));
    if (this.state === "closed") {
      try { ws.close(1000, "Session already closed."); } catch { /* ignore */ }
    }
  }

  private sendToClient(event: PublicEvent) {
    const ws = this.client;
    if (!ws || ws.readyState !== ws.OPEN) return false;
    ws.send(JSON.stringify(event));
    return true;
  }

  private emit(event: PublicEvent) {
    if (!this.sendToClient(event)) {
      this.buffer.push(event);
      if (this.buffer.length > BUFFER_LIMIT) this.buffer.splice(0, this.buffer.length - BUFFER_LIMIT);
    }
  }

  private async handleCommand(raw: string) {
    let command: JsonObject;
    try {
      command = JSON.parse(raw) as JsonObject;
    } catch {
      this.emit(errorEvent("Events must be JSON objects."));
      return;
    }
    const clientEventID = typeof command["event_id"] === "string" ? command["event_id"] : undefined;
    if (this.state !== "active") {
      this.emit(errorEvent(`The session is ${this.state}; commands are accepted only while active.`, clientEventID, "session_not_active"));
      return;
    }
    const plan = planCommand(command);
    this.logger.debug("command", { type: command["type"], kind: plan.kind, chars: typeof command["content"] === "string" ? command["content"].length : 0 });
    const codex = this.deps.codex;
    try {
      switch (plan.kind) {
        case "instruction": {
          const text = this.withPendingContext(APP_INSTRUCTION_PREFIX + plan.text.slice(0, MAX_COMMAND_CHARS));
          await codex.request("thread/realtime/appendText", { threadId: this.threadID, text }, 15_000);
          this.emit(ackEvent(plan.ack, clientEventID));
          break;
        }
        case "thinking": {
          const text = plan.text.slice(0, MAX_COMMAND_CHARS);
          if (this.deps.config.thinkingMode === "immediate") {
            await codex.request("thread/realtime/appendText", { threadId: this.threadID, text: APP_CONTEXT_PREFIX + text }, 15_000);
          } else {
            this.thinking.push(text);
            if (this.thinking.length > MAX_THINKING_ENTRIES) this.thinking.splice(0, this.thinking.length - MAX_THINKING_ENTRIES);
            this.scheduleQuietFlush();
          }
          this.emit(ackEvent(plan.ack, clientEventID));
          break;
        }
        case "speech": {
          await codex.request("thread/realtime/appendSpeech", { threadId: this.threadID, text: plan.text.slice(0, MAX_COMMAND_CHARS) }, 15_000);
          this.emit(ackEvent(plan.ack, clientEventID));
          break;
        }
        case "mute":
          // Muting is local to the client's audio track; the proxy only acknowledges it.
          this.emit(ackEvent(plan.ack, clientEventID));
          break;
        case "close":
          await this.close("client_request");
          break;
        case "invalid":
          this.emit(errorEvent(plan.message, clientEventID));
          break;
      }
    } catch (error) {
      this.emit(errorEvent(error instanceof Error ? error.message : String(error), clientEventID, "codex_error"));
    }
  }

  private withPendingContext(text: string): string {
    if (!this.thinking.length) return text;
    const context = APP_CONTEXT_PREFIX + this.thinking.join("\n");
    this.thinking = [];
    return `${context}\n${text}`;
  }

  private scheduleQuietFlush() {
    if (this.deps.config.thinkingMode !== "flush-on-quiet") return;
    if (this.quietTimer) clearTimeout(this.quietTimer);
    if (!this.thinking.length) return;
    this.quietTimer = setTimeout(() => {
      this.quietTimer = null;
      if (this.state !== "active" || !this.thinking.length) return;
      if (Date.now() - this.lastTranscriptAt < this.deps.config.quietSeconds * 1_000) { this.scheduleQuietFlush(); return; }
      const text = this.withPendingContext("");
      this.commandQueue = this.commandQueue.then(async () => {
        await this.deps.codex.request("thread/realtime/appendText", { threadId: this.threadID, text: text.trimEnd() }, 15_000);
      }).catch((error) => this.logger.debug("quiet flush failed", { error: String(error) }));
    }, this.deps.config.quietSeconds * 1_000);
  }

  // ---- shutdown ---------------------------------------------------------------------

  async close(reason: string, detail?: string): Promise<void> {
    if (this.state === "closed" || this.state === "closing") return;
    this.state = "closing";
    this.closeReason = reason;
    this.logger.info("closing session", { reason, detail });
    const { codex } = this.deps;
    if (this.threadID && codex.running) {
      const closed = new Promise<void>((resolve) => {
        const check = setInterval(() => { if (this.closedNotified) { clearInterval(check); resolve(); } }, 50);
        this.after(4_000, () => { clearInterval(check); resolve(); });
      });
      try {
        await codex.request("thread/realtime/stop", { threadId: this.threadID }, 5_000);
        await closed;
      } catch (error) {
        this.logger.debug("realtime stop failed", { error: String(error) });
      }
    }
    if (!this.closedNotified) {
      this.emit({ type: "session.closed", event_id: eventID(), reason, usage: { seconds: this.usageSeconds } });
      this.finishClosed(reason);
    }
  }

  private finishClosed(reason: string) {
    if (this.closedNotified) return;
    this.closedNotified = true;
    this.state = "closed";
    this.closeReason = this.closeReason ?? reason;
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    if (this.usageTicker) clearInterval(this.usageTicker);
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.clearGrace();
    const ws = this.client;
    this.client = null;
    if (ws) {
      const finish = () => { try { ws.close(1000, "Session closed."); } catch { /* ignore */ } };
      if (ws.bufferedAmount > 0) setTimeout(finish, 200);
      else finish();
    }
    this.logger.info("session closed", { reason: this.closeReason, seconds: this.usageSeconds });
    this.deps.onClosed(this);
  }
}
