/**
 * Port of apps/ios/App/APIClient.swift. The same code path serves both connection modes:
 * OpenAI directly (https://api.openai.com/v1 + your key) or the local Codex proxy
 * (http://<mac>:8790/v1 + its token). Only the base URL and bearer change.
 */
import type { LanguageModule } from "../core/languages";
import { safeURL, type SourceLink } from "../core/models";
import { assessmentSchema } from "../core/policy";

export interface Connection {
  mode: "openai" | "codex";
  baseURL: string;
  token: string;
  /** Live model and text model requested; the proxy maps them to its own. */
  liveModel: string;
  textModel: string;
  voice: string;
}

export const OPENAI_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_LIVE_MODEL = "gpt-live-1";
export const DEFAULT_TEXT_MODEL = "gpt-5.6-luna";
export const DEFAULT_VOICE = "marin";

export interface APIUsage {
  input: number;
  output: number;
  searches: number;
}
export interface APIResult {
  text: string;
  sources: SourceLink[];
  usage: APIUsage;
}

export class APIError extends Error {
  status: number | null;
  kind: "missingKey" | "invalidResponse" | "incomplete" | "refused" | "http" | "network";
  constructor(kind: APIError["kind"], status: number | null = null, detail?: string) {
    super(APIError.describe(kind, status, detail));
    this.kind = kind;
    this.status = status;
  }
  static describe(kind: APIError["kind"], status: number | null, detail?: string): string {
    switch (kind) {
      case "missingKey": return "Add your OpenAI key or connect the Codex proxy in Settings to begin.";
      case "invalidResponse":
      case "incomplete": return "The assistant returned an incomplete response. Please try again.";
      case "refused": return "Mural couldn’t complete that request. Try a different topic.";
      case "network": return detail ? `Could not reach the server: ${detail}` : "Could not reach the server. Check your connection and the proxy address.";
      case "http":
        if (status === 401) return "Your key or proxy token wasn’t accepted. Check it in Settings.";
        if (status === 403 || status === 404) return "This key may not have access to the requested model, or the proxy URL is wrong. Check Settings.";
        if (status === 429) return "The usage or rate limit was reached. Check your billing, limits or Codex quota.";
        return detail ? `The request failed (HTTP ${status}): ${detail}` : `The request couldn’t be completed (HTTP ${status}). Please try again.`;
    }
  }
}

type Json = Record<string, unknown>;

export class APIClient {
  private readonly connection: () => Connection | null;

  constructor(connection: () => Connection | null) {
    this.connection = connection;
  }

  current(): Connection | null {
    return this.connection();
  }

  async post(path: string, body: Json, signal?: AbortSignal): Promise<Json> {
    const connection = this.connection();
    if (!connection || !connection.token) throw new APIError("missingKey");
    const url = connection.baseURL.replace(/\/+$/, "") + "/" + path.replace(/^\/+/, "");
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { authorization: "Bearer " + connection.token, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: signal ?? AbortSignal.timeout(60_000),
        redirect: "error",
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      throw new APIError("network", null, error instanceof Error ? error.message : undefined);
    }
    if (!response.ok) {
      let detail: string | undefined;
      try {
        const payload = (await response.json()) as Json;
        const err = payload["error"] as Json | undefined;
        if (err && typeof err["message"] === "string") detail = err["message"];
      } catch { /* no JSON body */ }
      throw new APIError("http", response.status, detail);
    }
    try {
      return (await response.json()) as Json;
    } catch {
      throw new APIError("invalidResponse");
    }
  }

  async respond(instructions: string, input: string, options: { schema?: Record<string, unknown>; search?: boolean; signal?: AbortSignal } = {}): Promise<APIResult> {
    const connection = this.connection();
    const body: Json = {
      model: connection?.textModel ?? DEFAULT_TEXT_MODEL,
      store: false,
      instructions,
      input: [{ role: "user", content: input }],
      max_output_tokens: options.schema ? 2200 : 1400,
      reasoning: { effort: "low" },
    };
    if (options.schema) body["text"] = { format: { type: "json_schema", name: "mural_result", strict: true, schema: options.schema } };
    if (options.search) { body["tools"] = [{ type: "web_search" }]; body["tool_choice"] = "auto"; body["max_tool_calls"] = 1; }
    const json = await this.post("responses", body, options.signal);
    if (json["status"] !== "completed") throw new APIError("incomplete");
    let text = "";
    const sources: SourceLink[] = [];
    const usage: APIUsage = { input: 0, output: 0, searches: 0 };
    for (const item of (json["output"] as Json[] | undefined) ?? []) {
      if (item["type"] === "web_search_call") usage.searches += 1;
      for (const content of (item["content"] as Json[] | undefined) ?? []) {
        if (content["type"] === "refusal") throw new APIError("refused");
        if (content["type"] === "output_text" && typeof content["text"] === "string") text += content["text"];
        for (const citation of (content["annotations"] as Json[] | undefined) ?? []) {
          if (citation["type"] !== "url_citation" || typeof citation["url"] !== "string") continue;
          const source: SourceLink = { title: typeof citation["title"] === "string" ? citation["title"] : "Source", url: citation["url"] };
          if (safeURL(source) && !sources.some((s) => s.url === source.url)) sources.push(source);
        }
      }
    }
    const u = json["usage"] as Json | undefined;
    if (u) {
      usage.input = typeof u["input_tokens"] === "number" ? u["input_tokens"] : 0;
      usage.output = typeof u["output_tokens"] === "number" ? u["output_tokens"] : 0;
    }
    if (!text) throw new APIError("incomplete");
    return { text, sources, usage };
  }

  schema(language: LanguageModule): Record<string, unknown> {
    return assessmentSchema(language);
  }
}
