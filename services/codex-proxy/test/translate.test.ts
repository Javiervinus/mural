import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildPrompt, chooseVoice, contentText, delegationCompletedEvent, handoffInstructions, handoffRequest, historyToInitialItems, planCommand, proxyPreamble, translateNotification, usageEvent,
} from "../src/translate.ts";

describe("translateNotification", () => {
  it("maps realtime started to session.started with the public session id", () => {
    const [event] = translateNotification("thread/realtime/started", { threadId: "t", realtimeSessionId: "rt_1", version: "v3" }, "sess_a", 0);
    assert.equal(event?.type, "session.started");
    assert.deepEqual((event as unknown as { session: { id: string; realtime_session_id: string } }).session.id, "sess_a");
  });

  it("turns user and assistant deltas into input/output transcript deltas with timing", () => {
    const [user] = translateNotification("thread/realtime/transcript/delta", { threadId: "t", role: "user", delta: " Mi color" }, "s", 1500);
    const [assistant] = translateNotification("thread/realtime/transcript/delta", { threadId: "t", role: "assistant", delta: " Verde" }, "s", 2000);
    assert.equal(user?.type, "session.input_transcript.delta");
    assert.equal(assistant?.type, "session.output_transcript.delta");
    assert.equal(user?.["delta"], " Mi color");
    assert.equal(user?.["start_ms"], 1500);
    assert.ok((user?.["end_ms"] as number) > 1500);
    assert.ok(typeof user?.event_id === "string" && user.event_id.length > 4);
  });

  it("drops empty deltas and ignores audio notifications", () => {
    assert.deepEqual(translateNotification("thread/realtime/transcript/delta", { role: "user", delta: "" }, "s", 0), []);
    assert.deepEqual(translateNotification("thread/realtime/outputAudio/delta", { audio: {} }, "s", 0), []);
  });

  it("maps done, error and closed", () => {
    const [done] = translateNotification("thread/realtime/transcript/done", { role: "assistant", text: " Hola." }, "s", 0);
    assert.equal(done?.type, "session.output_transcript.done");
    const [error] = translateNotification("thread/realtime/error", { message: "boom" }, "s", 0);
    assert.equal(error?.type, "error");
    assert.equal((error as unknown as { error: { message: string } }).error.message, "boom");
    const [closed] = translateNotification("thread/realtime/closed", { reason: "requested" }, "s", 65_400);
    assert.equal(closed?.type, "session.closed");
    assert.deepEqual((closed as unknown as { usage: { seconds: number } }).usage, { seconds: 65 });
    assert.equal(closed?.["reason"], "requested");
  });

  it("reports usage in whole seconds", () => {
    assert.deepEqual(usageEvent(12_600)["usage"], { seconds: 13 });
  });
});

describe("planCommand", () => {
  it("maps the public commands", () => {
    assert.equal(planCommand({ type: "session.instructions.append", content: "Say hi" }).kind, "instruction");
    assert.equal(planCommand({ type: "session.thinking.append", content: "ctx" }).kind, "thinking");
    assert.equal(planCommand({ type: "session.commentary.append", content: "Hola" }).kind, "speech");
    assert.deepEqual(planCommand({ type: "session.input_audio.mute" }), { kind: "mute", muted: true, ack: "session.input_audio.muted" });
    assert.deepEqual(planCommand({ type: "session.close" }), { kind: "close" });
  });
  it("rejects unknown and empty commands", () => {
    assert.equal(planCommand({ type: "response.create" }).kind, "invalid");
    assert.equal(planCommand({ type: "session.commentary.append", content: "  " }).kind, "invalid");
    assert.equal(planCommand({}).kind, "invalid");
  });
});

describe("history and prompt", () => {
  it("converts public history messages into initial items", () => {
    const items = historyToInitialItems([
      { role: "user", content: "Hola" },
      { role: "assistant", content: [{ type: "output_text", text: "¡Hola!" }] },
      { role: "system", content: "ignored" },
      { role: "user", content: "" },
    ]);
    assert.deepEqual(items, [{ role: "user", text: "Hola" }, { role: "assistant", text: "¡Hola!" }]);
    assert.deepEqual(historyToInitialItems(undefined), []);
  });
  it("extracts text from content parts", () => {
    assert.equal(contentText([{ type: "input_text", text: "a" }, "b"]), "a\nb");
    assert.equal(contentText(42), "");
  });
  it("appends the silence preamble to the instructions", () => {
    const prompt = buildPrompt("Speak Spanish.");
    assert.ok(prompt.startsWith("Speak Spanish."));
    assert.ok(prompt.endsWith(proxyPreamble()));
    assert.equal(buildPrompt("  "), proxyPreamble());
  });
  it("substitutes unsupported voices", () => {
    assert.deepEqual(chooseVoice("marin", ["cove", "juniper"], "cove"), { voice: "cove", substituted: true });
    assert.deepEqual(chooseVoice("juniper", ["cove", "juniper"], "cove"), { voice: "juniper", substituted: false });
    assert.deepEqual(chooseVoice(undefined, ["cove"], "cove"), { voice: "cove", substituted: false });
    assert.deepEqual(chooseVoice("x", ["sol"], "cove"), { voice: "sol", substituted: true });
  });
});

describe("handoffs", () => {
  const handoffItem = { threadId: "t", item: { type: "handoff_request", handoff_id: "item_abc", item_id: "item_abc", input_transcript: "Why does 'I prefer' go first?" } };

  it("turns a handoff_request item into session.delegation.created for the server", () => {
    const [event] = translateNotification("thread/realtime/itemAdded", handoffItem, "s", 0);
    assert.equal(event?.type, "session.delegation.created");
    assert.deepEqual(event?.["delegation"], { id: "item_abc", target: "server", input: "Why does 'I prefer' go first?" });
  });

  it("ignores other realtime items and malformed handoffs", () => {
    assert.deepEqual(translateNotification("thread/realtime/itemAdded", { threadId: "t", item: { type: "transcriptSegment", text: "hi" } }, "s", 0), []);
    assert.equal(handoffRequest({ item: { type: "handoff_request" } }), null);
    assert.equal(handoffRequest({ item: "handoff_request" }), null);
    assert.deepEqual(handoffRequest({ item: { type: "handoff_request", item_id: "i_1" } }), { id: "i_1", input: "" });
  });

  it("reports the finished agent turn with its status and search count", () => {
    const event = delegationCompletedEvent("item_abc", "completed", 2);
    assert.equal(event.type, "session.delegation.completed");
    assert.deepEqual(event["delegation"], { id: "item_abc", target: "server", status: "completed", web_searches: 2 });
  });

  it("briefs the handoff agent and keeps the voice instructions as context", () => {
    const text = handoffInstructions("  Speak ONLY Spanish.  ");
    assert.ok(text.startsWith("You answer handoffs from a live voice conversation."));
    assert.ok(text.includes("at most 120 words"));
    assert.ok(text.endsWith("for context:\nSpeak ONLY Spanish."));
    assert.ok(!handoffInstructions("").includes("for context"));
  });
});
