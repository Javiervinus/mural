/**
 * `POST /v1/responses` on top of a Codex text turn.
 *
 * Each request gets an ephemeral, read-only Codex thread. Structured output uses the
 * app-server's `outputSchema`; web search uses Codex's own `web_search = "live"` tool.
 */
import { CODEX_EXITED, CodexClient } from "./codex.ts";
import type { ProxyConfig } from "./config.ts";
import type { Logger } from "./log.ts";
import { collectSearchResults, RequestError, renderCitations, unwrapJsonFence, type NormalisedRequest, type SearchResult, type TextTurnOutcome } from "./responses-format.ts";
import type { JsonObject } from "./translate.ts";

export interface ModelInfo {
  id: string;
  efforts: string[];
  defaultEffort: string | null;
  isDefault: boolean;
  hidden: boolean;
}

export interface ModelCatalog {
  models: ModelInfo[];
  fetchedAt: number;
}

const CATALOG_TTL_MS = 10 * 60_000;
const TURN_TIMEOUT_MS = 180_000;

const ANSWER_GUARD = "You are answering a single request through an API. Do not run commands, read files or use any tool except web search when it is available. Reply with the final answer only, with no preamble about what you did.";

function effortName(option: unknown): string | null {
  if (typeof option === "string") return option;
  if (option && typeof option === "object") {
    const record = option as JsonObject;
    for (const key of ["reasoningEffort", "effort", "id", "value"]) {
      if (typeof record[key] === "string") return record[key] as string;
    }
  }
  return null;
}

export class TextTurnRunner {
  private readonly codex: CodexClient;
  private readonly config: ProxyConfig;
  private readonly logger: Logger;
  private catalog: ModelCatalog | null = null;

  constructor(codex: CodexClient, config: ProxyConfig, logger: Logger) {
    this.codex = codex;
    this.config = config;
    this.logger = logger.child("responses");
  }

  async models(): Promise<ModelCatalog> {
    if (this.catalog && Date.now() - this.catalog.fetchedAt < CATALOG_TTL_MS) return this.catalog;
    const response = await this.codex.request<JsonObject>("model/list", { includeHidden: true }, 20_000);
    const data = Array.isArray(response["data"]) ? (response["data"] as JsonObject[]) : [];
    const models: ModelInfo[] = data
      .filter((entry) => typeof entry["id"] === "string")
      .map((entry) => ({
        id: entry["id"] as string,
        efforts: Array.isArray(entry["supportedReasoningEfforts"]) ? (entry["supportedReasoningEfforts"] as unknown[]).map(effortName).filter((e): e is string => !!e) : [],
        defaultEffort: typeof entry["defaultReasoningEffort"] === "string" ? entry["defaultReasoningEffort"] : null,
        isDefault: entry["isDefault"] === true,
        hidden: entry["hidden"] === true,
      }));
    this.catalog = { models, fetchedAt: Date.now() };
    return this.catalog;
  }

  /** Resolves the request's model and effort against what Codex actually offers. */
  async resolve(request: NormalisedRequest): Promise<{ model: string; effort: string | null }> {
    const catalog = await this.models();
    const byID = new Map(catalog.models.map((m) => [m.id, m]));
    const requested = request.model && byID.get(request.model);
    const configured = byID.get(this.config.textModel);
    const fallback = catalog.models.find((m) => m.isDefault) ?? catalog.models.find((m) => !m.hidden) ?? catalog.models[0];
    const model = requested || configured || fallback;
    if (!model) throw new RequestError("Codex reported no available models. Check `codex login`.", 502);
    if (request.model && model.id !== request.model) this.logger.info("text model mapped", { requested: request.model, model: model.id });
    const wanted = request.effort ?? this.config.textEffort;
    const effort = model.efforts.length === 0 ? wanted : model.efforts.includes(wanted) ? wanted : model.efforts.includes(this.config.textEffort) ? this.config.textEffort : model.defaultEffort;
    return { model: model.id, effort };
  }

  async run(request: NormalisedRequest): Promise<TextTurnOutcome> {
    await this.codex.ensure();
    const { model, effort } = await this.resolve(request);
    const instructions = [request.instructions, ANSWER_GUARD].filter(Boolean).join("\n\n");
    const thread = await this.codex.request<JsonObject>("thread/start", {
      cwd: this.config.dataDir,
      ephemeral: true,
      approvalPolicy: "never",
      sandbox: "read-only",
      baseInstructions: instructions,
      config: { web_search: request.webSearch ? "live" : "disabled" },
    }, 30_000);
    const threadID = ((thread["thread"] ?? {}) as JsonObject)["id"];
    if (typeof threadID !== "string") throw new RequestError("Codex did not return a thread id.", 502);

    let searchCalls = 0;
    const searchResults = new Map<string, SearchResult>();
    let finalText = "";
    let lastAgentText = "";
    let usage: JsonObject | null = null;
    let turnID: string | null = null;
    const done = new Promise<{ status: string; error: string | null }>((resolve) => {
      const unsubscribe = this.codex.subscribe(threadID, (method, params) => {
        if (method === CODEX_EXITED) { unsubscribe(); resolve({ status: "failed", error: "Codex exited during the request." }); return; }
        if (method === "item/completed") {
          const item = (params["item"] ?? {}) as JsonObject;
          if (item["type"] === "webSearch") { searchCalls += 1; collectSearchResults(item, searchResults); }
          if (item["type"] === "agentMessage" && typeof item["text"] === "string") {
            lastAgentText = item["text"];
            if (item["phase"] === "final_answer" || item["phase"] === null || item["phase"] === undefined) finalText = item["text"];
          }
        } else if (method === "thread/tokenUsage/updated") {
          usage = (params["tokenUsage"] ?? null) as JsonObject | null;
        } else if (method === "turn/completed") {
          const turn = (params["turn"] ?? {}) as JsonObject;
          const error = turn["error"] as JsonObject | null | undefined;
          unsubscribe();
          resolve({ status: typeof turn["status"] === "string" ? turn["status"] : "completed", error: error && typeof error["message"] === "string" ? error["message"] : null });
        } else if (method === "error") {
          const error = (params["error"] ?? params) as JsonObject;
          unsubscribe();
          resolve({ status: "failed", error: typeof error["message"] === "string" ? error["message"] : "Codex reported an error." });
        }
      });
      setTimeout(() => { unsubscribe(); resolve({ status: "timeout", error: "Codex did not finish the turn in time." }); }, TURN_TIMEOUT_MS);
    });

    const turnParams: JsonObject = {
      threadId: threadID,
      input: [{ type: "text", text: request.input, text_elements: [] }],
      model,
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    };
    if (effort) turnParams["effort"] = effort;
    if (request.schema) turnParams["outputSchema"] = request.schema;
    const started = Date.now();
    const turn = await this.codex.request<JsonObject>("turn/start", turnParams, 30_000);
    turnID = typeof ((turn["turn"] ?? {}) as JsonObject)["id"] === "string" ? (((turn["turn"] as JsonObject)["id"]) as string) : null;

    const outcome = await done;
    if (outcome.status === "timeout" && turnID) {
      this.codex.request("turn/interrupt", { threadId: threadID, turnId: turnID }, 5_000).catch(() => undefined);
    }
    const seconds = Math.round((Date.now() - started) / 100) / 10;
    if (outcome.status !== "completed") {
      this.logger.warn("text turn did not complete", { status: outcome.status, error: outcome.error, seconds });
      throw new RequestError(outcome.error ?? `Codex turn ended with status ${outcome.status}.`, 502);
    }
    let text = finalText || lastAgentText;
    if (!text.trim()) throw new RequestError("Codex returned an empty answer.", 502);
    if (!request.schema) text = renderCitations(text, searchResults);
    if (request.schema) {
      text = unwrapJsonFence(text);
      try {
        JSON.parse(text);
      } catch {
        throw new RequestError("Codex did not return valid JSON for the requested schema.", 502);
      }
    }
    const total = usage ? ((usage as JsonObject)["total"] as JsonObject | undefined) : undefined;
    const inputTokens = typeof total?.["inputTokens"] === "number" ? total["inputTokens"] : 0;
    const outputTokens = typeof total?.["outputTokens"] === "number" ? total["outputTokens"] : 0;
    this.logger.info("text turn completed", { model, effort, seconds, search: searchCalls, input: inputTokens, output: outputTokens });
    return { text, searchCalls, model, usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens } };
  }
}
