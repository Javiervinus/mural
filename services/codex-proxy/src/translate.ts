/**
 * Pure translation between the public GPT-Live event vocabulary (what clients speak)
 * and the Codex app-server realtime protocol (what the proxy speaks to `codex`).
 *
 * Nothing in this module touches the network, so it is fully unit-tested.
 */

export type JsonObject = Record<string, unknown>;

/** A public-shaped event the proxy emits to its WebSocket client. */
export interface PublicEvent extends JsonObject {
  type: string;
  event_id: string;
}

export interface TranscriptState {
  /** Monotonic transcript clock, milliseconds since the session became active. */
  elapsedMs: number;
}

let serial = 0;
export function eventID(prefix = "evt"): string {
  serial += 1;
  return `${prefix}_${Date.now().toString(36)}${serial.toString(36)}`;
}

/** Approximate spoken duration of a transcript delta, used only for passage grouping on the client. */
export function estimateDurationMs(text: string): number {
  const characters = text.trim().length;
  return Math.max(40, Math.round(characters * 55));
}

/**
 * Converts one Codex realtime notification into zero or more public events.
 * `sessionID` is the public session identifier, `elapsedMs` the session clock at receipt.
 */
export function translateNotification(method: string, params: JsonObject, sessionID: string, elapsedMs: number): PublicEvent[] {
  switch (method) {
    case "thread/realtime/started":
      return [{ type: "session.started", event_id: eventID(), session: { id: sessionID, status: "active", realtime_session_id: params["realtimeSessionId"] ?? null } }];
    case "thread/realtime/transcript/delta": {
      const role = params["role"] === "user" ? "input" : "output";
      const delta = typeof params["delta"] === "string" ? params["delta"] : "";
      if (!delta) return [];
      const start = Math.max(0, Math.round(elapsedMs));
      return [{ type: `session.${role}_transcript.delta`, event_id: eventID("frag"), delta, start_ms: start, end_ms: start + estimateDurationMs(delta) }];
    }
    case "thread/realtime/transcript/done": {
      const role = params["role"] === "user" ? "input" : "output";
      const text = typeof params["text"] === "string" ? params["text"] : "";
      return [{ type: `session.${role}_transcript.done`, event_id: eventID(), text }];
    }
    case "thread/realtime/error": {
      const message = typeof params["message"] === "string" ? params["message"] : "The voice session reported an error.";
      return [{ type: "error", event_id: eventID(), error: { type: "server_error", code: "realtime_error", message } }];
    }
    case "thread/realtime/closed": {
      const reason = typeof params["reason"] === "string" ? params["reason"] : null;
      return [{ type: "session.closed", event_id: eventID(), reason, usage: { seconds: Math.round(elapsedMs / 1000) } }];
    }
    case "thread/realtime/itemAdded": {
      const handoff = handoffRequest(params);
      if (!handoff) return [];
      return [{ type: "session.delegation.created", event_id: eventID(), delegation: { id: handoff.id, target: "server", input: handoff.input } }];
    }
    default:
      return [];
  }
}

/**
 * The live model asks Codex for help by adding a `handoff_request` item to the thread; Codex then
 * runs an agent turn and, with `codexResponseHandoffMode: "commentary"`, speaks the answer itself.
 * Returns the request when `params` carries one, otherwise null.
 */
export function handoffRequest(params: JsonObject): { id: string; input: string } | null {
  const item = params["item"];
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const record = item as JsonObject;
  if (record["type"] !== "handoff_request") return null;
  const id = typeof record["handoff_id"] === "string" ? record["handoff_id"] : typeof record["item_id"] === "string" ? record["item_id"] : null;
  if (!id) return null;
  return { id, input: typeof record["input_transcript"] === "string" ? record["input_transcript"] : "" };
}

/** Emitted when the agent turn behind a handoff finishes, so clients can drop their "working" state. */
export function delegationCompletedEvent(id: string, status: "completed" | "failed", searches: number): PublicEvent {
  return { type: "session.delegation.completed", event_id: eventID(), delegation: { id, target: "server", status, web_searches: searches } };
}

export function usageEvent(elapsedMs: number): PublicEvent {
  return { type: "session.usage.updated", event_id: eventID(), usage: { seconds: Math.round(elapsedMs / 1000) } };
}

export function errorEvent(message: string, clientEventID?: string, code = "invalid_request_error"): PublicEvent {
  const error: JsonObject = { type: code === "invalid_request_error" ? "invalid_request_error" : "server_error", code, message };
  if (clientEventID) error["client_event_id"] = clientEventID;
  return { type: "error", event_id: eventID(), error };
}

export function ackEvent(type: string, clientEventID: string | undefined): PublicEvent {
  const event: PublicEvent = { type, event_id: eventID() };
  if (clientEventID) event["client_event_id"] = clientEventID;
  return event;
}

/**
 * Framing that tells the live model where an injected message comes from. Verified against the
 * full Mural voice prompt on 15 September 2026: this wording makes the model act on instructions
 * aloud (greeting in 3–5 s), while the softer "follow it, never read it aloud" left it silent.
 */
export const APP_INSTRUCTION_PREFIX = "[App instruction — act on it now, aloud] ";
export const APP_CONTEXT_PREFIX = "[App context] ";

/**
 * The public API only speaks when instructed; Codex's live model greets on its own.
 * This preamble makes the Codex session behave like the public one.
 */
export function proxyPreamble(): string {
  return [
    "Application protocol (overrides any earlier instruction about when to speak):",
    "Say nothing when the session starts. Wait silently for the application's first message.",
    "Messages that begin with [App instruction] are commands from the application: carry them out immediately by SPEAKING in the target language, in your own words, as if the situation had just happened.",
    "Messages that begin with [App context] are background information: remember them silently and do not respond to them.",
    "Never read the bracketed text or mention the application.",
  ].join(" ");
}

export function buildPrompt(instructions: string): string {
  const trimmed = instructions.trim();
  return trimmed ? `${trimmed}\n\n${proxyPreamble()}` : proxyPreamble();
}

/**
 * Base instructions for the Codex agent that answers the live model's handoffs. The public API
 * lets the client answer delegations with its own text model; here Codex answers on the Mac, so
 * the agent is briefed like Mural's delegation prompt and sees the voice instructions as context.
 */
export function handoffInstructions(instructions: string): string {
  const note = [
    "You answer handoffs from a live voice conversation.",
    "The voice assistant hands you a request it cannot answer alone (an explanation, a fact to check, a current topic) and reads your reply aloud.",
    "Reply in the conversation's target language as plain spoken prose: at most 120 words, no markdown, headings or lists.",
    "Use web search only for current or uncertain facts the learner asked about, and say when you could not verify something.",
    "Never run commands, edit files or claim to have performed real-world actions.",
  ].join(" ");
  const trimmed = instructions.trim();
  return trimmed ? `${note}\n\nThe voice assistant's own instructions, for context:\n${trimmed}` : note;
}

/** Public command types the proxy understands, mapped to how they are executed. */
export type CommandPlan =
  | { kind: "instruction"; text: string; ack: string }
  | { kind: "thinking"; text: string; ack: string }
  | { kind: "speech"; text: string; ack: string }
  | { kind: "mute"; muted: boolean; ack: string }
  | { kind: "close" }
  | { kind: "invalid"; message: string };

export function planCommand(command: JsonObject): CommandPlan {
  const type = typeof command["type"] === "string" ? command["type"] : "";
  const content = typeof command["content"] === "string" ? command["content"] : typeof command["text"] === "string" ? command["text"] : "";
  switch (type) {
    case "session.instructions.append":
      return content.trim() ? { kind: "instruction", text: content, ack: "session.instructions.appended" } : { kind: "invalid", message: "session.instructions.append needs a non-empty content string." };
    case "session.thinking.append":
      return content.trim() ? { kind: "thinking", text: content, ack: "session.thinking.appended" } : { kind: "invalid", message: "session.thinking.append needs a non-empty content string." };
    case "session.commentary.append":
      return content.trim() ? { kind: "speech", text: content, ack: "session.commentary.appended" } : { kind: "invalid", message: "session.commentary.append needs a non-empty content string." };
    case "session.input_audio.mute":
      return { kind: "mute", muted: true, ack: "session.input_audio.muted" };
    case "session.input_audio.unmute":
      return { kind: "mute", muted: false, ack: "session.input_audio.unmuted" };
    case "session.close":
      return { kind: "close" };
    default:
      return { kind: "invalid", message: type ? `Unknown event type "${type}".` : "Every event needs a string type." };
  }
}

/** Converts the public `session.input` history into Codex `initialItems`. */
export function historyToInitialItems(input: unknown): Array<{ role: "user" | "assistant"; text: string }> {
  if (!Array.isArray(input)) return [];
  const items: Array<{ role: "user" | "assistant"; text: string }> = [];
  for (const entry of input) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as JsonObject;
    const role = record["role"] === "assistant" ? "assistant" : record["role"] === "user" ? "user" : null;
    if (!role) continue;
    const text = contentText(record["content"] ?? record["text"]);
    if (text) items.push({ role, text });
  }
  return items;
}

/** Extracts plain text from a Responses-style content value (string or content-part array). */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && typeof (part as JsonObject)["text"] === "string") return (part as JsonObject)["text"] as string;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/** Picks a voice the Codex V3 backend accepts, falling back to the configured default. */
export function chooseVoice(requested: unknown, supported: string[], fallback: string): { voice: string; substituted: boolean } {
  if (typeof requested === "string" && supported.includes(requested)) return { voice: requested, substituted: false };
  const voice = supported.includes(fallback) ? fallback : supported[0] ?? fallback;
  return { voice, substituted: typeof requested === "string" && requested !== voice };
}
