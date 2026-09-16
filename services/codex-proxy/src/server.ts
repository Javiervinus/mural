import { timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { CodexClient } from "./codex.ts";
import type { ProxyConfig } from "./config.ts";
import { LiveSession } from "./live.ts";
import type { Logger } from "./log.ts";
import { normaliseRequest, buildResponse, RequestError } from "./responses-format.ts";
import { TextTurnRunner } from "./responses.ts";
import type { JsonObject } from "./translate.ts";

export const PROXY_VERSION = "0.1.0";
const MAX_BODY_BYTES = 2_000_000;

export interface ServerDeps {
  config: ProxyConfig;
  codex: CodexClient;
  logger: Logger;
  token: string;
}

export class SessionRegistry {
  private sessions = new Map<string, LiveSession>();
  add(session: LiveSession) { this.sessions.set(session.id, session); }
  remove(session: LiveSession) { this.sessions.delete(session.id); }
  get(id: string): LiveSession | undefined { return this.sessions.get(id); }
  get size(): number { return this.sessions.size; }
  list(): LiveSession[] { return [...this.sessions.values()]; }
  async closeAll(reason: string) { await Promise.all(this.list().map((s) => s.close(reason))); }
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

function errorBody(message: string, type = "invalid_request_error", code: string | null = null) {
  return { error: { message, type, code, param: null } };
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new RequestError("The request body is too large.", 413);
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new RequestError("The request body is not valid JSON.");
  }
}

export function bearerMatches(header: string | undefined, token: string): boolean {
  if (!header) return false;
  const candidate = Buffer.from(header.trim());
  const expected = Buffer.from(`Bearer ${token}`);
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

export function createProxyServer(deps: ServerDeps): { server: http.Server; sessions: SessionRegistry; runner: TextTurnRunner } {
  const { config, codex, logger, token } = deps;
  const sessions = new SessionRegistry();
  const runner = new TextTurnRunner(codex, config, logger);
  const wss = new WebSocketServer({ noServer: true });
  let supportedVoices: string[] | null = null;

  async function voices(): Promise<string[]> {
    if (supportedVoices) return supportedVoices;
    try {
      const list = await codex.request<JsonObject>("thread/realtime/listVoices", {}, 15_000);
      // The V3 realtime backend accepts the "v1" generation (cove, juniper, ...); "v2" voices such as marin are rejected.
      const v1 = Array.isArray(list["v1"]) ? (list["v1"] as unknown[]).filter((v): v is string => typeof v === "string") : [];
      supportedVoices = v1.length ? v1 : [config.defaultVoice];
    } catch (error) {
      logger.warn("could not list voices; using the default", { error: String(error) });
      supportedVoices = [config.defaultVoice];
    }
    return supportedVoices;
  }

  function applyCors(req: http.IncomingMessage, res: http.ServerResponse) {
    const origin = req.headers.origin;
    const allowed = config.corsOrigins.includes("*") ? "*" : origin && config.corsOrigins.includes(origin) ? origin : null;
    if (allowed) {
      res.setHeader("access-control-allow-origin", allowed);
      res.setHeader("access-control-allow-headers", "authorization, content-type");
      res.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
      res.setHeader("access-control-max-age", "600");
      if (allowed !== "*") res.setHeader("vary", "origin");
    }
  }

  function eventsURL(req: http.IncomingMessage, id: string): string {
    const forwarded = req.headers["x-forwarded-proto"];
    const secure = (typeof forwarded === "string" ? forwarded : "").split(",")[0]?.trim() === "https";
    const host = req.headers.host ?? `${config.host}:${config.port}`;
    return `${secure ? "wss" : "ws"}://${host}/v1/live/sessions/${id}/events`;
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    applyCors(req, res);
    res.setHeader("cache-control", "no-store");
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    if (path === "/healthz" || path === "/") {
      json(res, 200, {
        ok: true,
        service: "codex-proxy",
        version: PROXY_VERSION,
        codex: { running: codex.running, account: codex.account, agent: codex.userAgent },
        live_model: config.liveModel,
        text_model: config.textModel,
        sessions: sessions.size,
      });
      return;
    }
    if (!path.startsWith("/v1/")) { json(res, 404, errorBody("Not found.", "invalid_request_error", "not_found")); return; }
    if (!bearerMatches(req.headers.authorization, token)) {
      json(res, 401, errorBody("Missing or invalid bearer token. Use the token printed by codex-proxy at startup.", "authentication_error", "invalid_api_key"));
      return;
    }

    if (path === "/v1/models" && req.method === "GET") {
      const catalog = await runner.models();
      const data = [{ id: config.liveModel, object: "model", owned_by: "codex", kind: "live" }, ...catalog.models.map((m) => ({ id: m.id, object: "model", owned_by: "codex", kind: "text", reasoning_efforts: m.efforts, default: m.isDefault }))];
      json(res, 200, { object: "list", data });
      return;
    }

    if (path === "/v1/live/sessions" && req.method === "POST") {
      const body = (await readBody(req)) as JsonObject;
      const sessionSpec = (body["session"] ?? {}) as JsonObject;
      const transport = (body["transport"] ?? {}) as JsonObject;
      if (transport["type"] !== "webrtc" || typeof transport["sdp"] !== "string" || !transport["sdp"].startsWith("v=0")) {
        throw new RequestError("`transport` must be {type: \"webrtc\", sdp: <offer>}; only WebRTC is supported.");
      }
      const audio = (sessionSpec["audio"] ?? {}) as JsonObject;
      const output = (audio["output"] ?? {}) as JsonObject;
      const session = new LiveSession({ config, codex, logger, supportedVoices: await voices(), onClosed: (s) => sessions.remove(s) });
      sessions.add(session);
      try {
        const answer = await session.start({
          instructions: typeof sessionSpec["instructions"] === "string" ? sessionSpec["instructions"] : "",
          voice: output["voice"],
          input: sessionSpec["input"],
          model: typeof sessionSpec["model"] === "string" ? sessionSpec["model"] : null,
          sdp: transport["sdp"],
        });
        logger.info("live session started", { id: session.id, voice: session.voice, history: Array.isArray(sessionSpec["input"]) ? (sessionSpec["input"] as unknown[]).length : 0 });
        json(res, 200, { session: session.toJSON(), transport: { type: "webrtc", sdp: answer }, events: { type: "websocket", url: eventsURL(req, session.id) } });
      } catch (error) {
        sessions.remove(session);
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("live session failed to start", { error: message });
        json(res, 502, errorBody(message, "server_error", "live_session_failed"));
      }
      return;
    }

    const sessionMatch = path.match(/^\/v1\/live\/sessions\/([A-Za-z0-9_-]+)(?:\/(close))?$/);
    if (sessionMatch) {
      const session = sessions.get(sessionMatch[1]!);
      if (!session) { json(res, 404, errorBody("Unknown or finished session.", "invalid_request_error", "session_not_found")); return; }
      if (req.method === "GET" && !sessionMatch[2]) { json(res, 200, session.toJSON()); return; }
      if (req.method === "DELETE" || (req.method === "POST" && sessionMatch[2] === "close")) {
        await session.close("client_request");
        json(res, 200, session.toJSON());
        return;
      }
    }

    if (path === "/v1/responses" && req.method === "POST") {
      const request = normaliseRequest(await readBody(req));
      const outcome = await runner.run(request);
      json(res, 200, buildResponse(outcome));
      return;
    }

    json(res, 404, errorBody(`No route for ${req.method} ${path}.`, "invalid_request_error", "not_found"));
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      const status = error instanceof RequestError ? error.status : 500;
      const message = error instanceof Error ? error.message : String(error);
      if (status >= 500) logger.error("request failed", { method: req.method, url: req.url, error: message });
      if (!res.headersSent) json(res, status, errorBody(message, status >= 500 ? "server_error" : "invalid_request_error"));
      else res.end();
    });
  });

  server.on("upgrade", (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const match = url.pathname.match(/^\/v1\/live\/sessions\/([A-Za-z0-9_-]+)\/events$/);
    const queryToken = url.searchParams.get("token");
    const authorized = bearerMatches(req.headers.authorization, token) || (queryToken !== null && bearerMatches(`Bearer ${queryToken}`, token));
    const session = match ? sessions.get(match[1]!) : undefined;
    if (!match || !authorized || !session) {
      const status = !match ? 404 : !authorized ? 401 : 404;
      socket.write(`HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : "Not Found"}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => session.attach(ws));
  });

  return { server, sessions, runner };
}
