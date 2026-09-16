/**
 * Pure helpers for `POST /v1/responses`: request normalisation and response shaping.
 */
import { contentText, type JsonObject } from "./translate.ts";

export interface NormalisedRequest {
  model: string | null;
  effort: string | null;
  instructions: string;
  input: string;
  schema: JsonObject | null;
  schemaName: string | null;
  webSearch: boolean;
}

export class RequestError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Accepts the subset of the public Responses request body that helper calls use. */
export function normaliseRequest(body: unknown): NormalisedRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new RequestError("The request body must be a JSON object.");
  const record = body as JsonObject;
  const model = typeof record["model"] === "string" && record["model"].trim() ? record["model"].trim() : null;
  const reasoning = record["reasoning"];
  const effort = reasoning && typeof reasoning === "object" && typeof (reasoning as JsonObject)["effort"] === "string" ? ((reasoning as JsonObject)["effort"] as string) : null;

  const systemParts: string[] = [];
  if (typeof record["instructions"] === "string" && record["instructions"].trim()) systemParts.push(record["instructions"].trim());

  const userParts: string[] = [];
  const input = record["input"];
  if (typeof input === "string") {
    userParts.push(input);
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (!item || typeof item !== "object") continue;
      const message = item as JsonObject;
      const text = contentText(message["content"] ?? message["text"]);
      if (!text.trim()) continue;
      const role = typeof message["role"] === "string" ? message["role"] : "user";
      if (role === "system" || role === "developer") systemParts.push(text.trim());
      else if (role === "assistant") userParts.push(`Previous assistant message:\n${text}`);
      else userParts.push(text);
    }
  } else if (input !== undefined) {
    throw new RequestError("`input` must be a string or an array of messages.");
  }
  if (!userParts.length) throw new RequestError("`input` must contain at least one user message.");

  let schema: JsonObject | null = null;
  let schemaName: string | null = null;
  const text = record["text"];
  if (text && typeof text === "object") {
    const format = (text as JsonObject)["format"];
    if (format && typeof format === "object") {
      const formatRecord = format as JsonObject;
      if (formatRecord["type"] === "json_schema") {
        if (!formatRecord["schema"] || typeof formatRecord["schema"] !== "object") throw new RequestError("`text.format.schema` must be a JSON schema object.");
        schema = formatRecord["schema"] as JsonObject;
        schemaName = typeof formatRecord["name"] === "string" ? formatRecord["name"] : null;
      } else if (formatRecord["type"] === "json_object") {
        schema = { type: "object", additionalProperties: true };
      }
    }
  }

  const tools = record["tools"];
  const webSearch = Array.isArray(tools) && tools.some((tool) => tool && typeof tool === "object" && typeof (tool as JsonObject)["type"] === "string" && ((tool as JsonObject)["type"] as string).startsWith("web_search"));

  return { model, effort, instructions: systemParts.join("\n\n"), input: userParts.join("\n\n"), schema, schemaName, webSearch };
}

export interface Citation {
  type: "url_citation";
  url: string;
  title: string;
  start_index: number;
  end_index: number;
}

const MARKDOWN_LINK = /\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]+)\)/g;

/** Turns markdown links in Codex's answer into Responses-style `url_citation` annotations. */
export function extractCitations(text: string): Citation[] {
  const citations: Citation[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(MARKDOWN_LINK)) {
    const url = match[2]!;
    const title = match[1]!.trim();
    const start = match.index ?? 0;
    if (!url.startsWith("https://") || seen.has(url)) continue;
    seen.add(url);
    citations.push({ type: "url_citation", url, title: title || url, start_index: start, end_index: start + match[0].length });
  }
  return citations;
}

export interface ResponseUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export interface TextTurnOutcome {
  text: string;
  searchCalls: number;
  usage: ResponseUsage;
  model: string;
}

let responseSerial = 0;

/** Builds a Responses API-compatible object from a completed Codex turn. */
export function buildResponse(outcome: TextTurnOutcome): JsonObject {
  responseSerial += 1;
  const output: JsonObject[] = [];
  for (let i = 0; i < outcome.searchCalls; i += 1) {
    output.push({ type: "web_search_call", id: `ws_${responseSerial}_${i}`, status: "completed" });
  }
  output.push({
    type: "message",
    id: `msg_${responseSerial}`,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: outcome.text, annotations: extractCitations(outcome.text) }],
  });
  return {
    id: `resp_codex_${Date.now().toString(36)}_${responseSerial}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: outcome.model,
    output,
    usage: outcome.usage,
    provider: "codex-proxy",
  };
}

export interface SearchResult {
  refID: string;
  url: string;
  title: string;
  domain: string;
}

/** Collects `{ref_id, url, title, domain}` entries from a Codex `webSearch` item's results. */
export function collectSearchResults(item: JsonObject, into: Map<string, SearchResult>): void {
  const results = Array.isArray(item["results"]) ? (item["results"] as unknown[]) : [];
  for (const entry of results) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as JsonObject;
    const refID = record["ref_id"];
    const url = record["url"];
    if (typeof refID !== "string" || typeof url !== "string" || !url.startsWith("https://")) continue;
    into.set(refID, {
      refID,
      url,
      title: typeof record["title"] === "string" && record["title"].trim() ? record["title"].trim() : url,
      domain: typeof record["domain"] === "string" && record["domain"].trim() ? record["domain"].trim() : new URL(url).hostname,
    });
  }
}

// Codex sometimes cites with private-use markers such as "\uE200cite\uE202turn0search0\uE201"
// instead of markdown links. Each token maps to a search result's ref_id.
const CITE_GROUP = /[\uE000-\uF8FF]*\bcite[\uE000-\uF8FF]*((?:turn\d+[a-z]+\d+[\uE000-\uF8FF]*)+)/g;
const CITE_REF = /turn\d+[a-z]+\d+/g;

/** Rewrites citation markers as markdown links to the matching search results and drops stray markers. */
export function renderCitations(text: string, results: Map<string, SearchResult>): string {
  let output = text.replace(CITE_GROUP, (_whole, group: string) => {
    const refs = [...new Set(group.match(CITE_REF) ?? [])];
    const links = refs.map((ref) => results.get(ref)).filter((r): r is SearchResult => !!r).map((r) => `[${r.domain}](${r.url})`);
    return links.length ? ` (${links.join(", ")})` : "";
  });
  output = output.replace(/[\uE000-\uF8FF]+/g, "");
  return output.replace(/[ \t]+(?=\n)/g, "").replace(/ {2,}/g, " ").trim();
}

/** Strips a ```json fence if the model wrapped structured output in one. */
export function unwrapJsonFence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1]!.trim() : trimmed;
}
