/**
 * Thin JSON-RPC client for `codex app-server --stdio`.
 *
 * One long-lived child process serves every proxy request; each voice session or text
 * turn gets its own ephemeral thread. The process is started lazily and restarted on
 * the next request if it exits.
 */
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { Logger } from "./log.ts";
import type { JsonObject } from "./translate.ts";

export const CODEX_EXITED = "proxy/codexExited";

export type NotificationHandler = (method: string, params: JsonObject) => void;

export class RpcError extends Error {
  code: number | null;
  data: unknown;
  constructor(message: string, code: number | null = null, data: unknown = undefined) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

export interface CodexAccount {
  type: string | null;
  email: string | null;
  planType: string | null;
}

export interface CodexClientOptions {
  bin: string;
  workspace: string;
  logger: Logger;
  /** Feature flags switched off for proxy threads so the model gets a lean toolset. */
  disabledFeatures?: string[];
  /** Extra `-c key=value` overrides. */
  configOverrides?: string[];
  codexHome?: string;
}

const DEFAULT_DISABLED_FEATURES = ["hooks", "apps", "computer_use", "browser_use", "plugins", "multi_agent", "image_generation", "skill_search", "tool_suggest", "goals"];

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

/** Names under `[mcp_servers.<name>]` in the user's Codex config; only these accept an `enabled=false` override. */
export function mcpServerNamesFromToml(toml: string): string[] {
  const names: string[] = [];
  for (const line of toml.split(/\r?\n/)) {
    const match = line.match(/^\s*\[mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\]\s*$/);
    const name = match?.[1] ?? match?.[2];
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

export async function configuredMcpServerNames(codexHome: string): Promise<string[]> {
  try {
    return mcpServerNamesFromToml(await readFile(join(codexHome, "config.toml"), "utf8"));
  } catch {
    return [];
  }
}

export class CodexClient {
  private readonly options: CodexClientOptions;
  private readonly logger: Logger;
  private child: ChildProcessByStdio<Writable, Readable, Readable> | null = null;
  private pending = new Map<number, Pending>();
  private serial = 0;
  private starting: Promise<void> | null = null;
  private threadHandlers = new Map<string, Set<NotificationHandler>>();
  private globalHandlers = new Set<NotificationHandler>();
  private stopping = false;
  account: CodexAccount | null = null;
  userAgent: string | null = null;
  startedAt: number | null = null;

  constructor(options: CodexClientOptions) {
    this.options = options;
    this.logger = options.logger;
  }

  get running(): boolean {
    return this.child !== null && this.child.exitCode === null && !this.stopping;
  }

  get codexHome(): string {
    return this.options.codexHome ?? process.env["CODEX_HOME"] ?? join(homedir(), ".codex");
  }

  async ensure(): Promise<void> {
    if (this.running) return;
    if (!this.starting) this.starting = this.start().finally(() => { this.starting = null; });
    return this.starting;
  }

  private async buildArgs(): Promise<string[]> {
    const args = ["--enable", "realtime_conversation"];
    for (const feature of this.options.disabledFeatures ?? DEFAULT_DISABLED_FEATURES) args.push("--disable", feature);
    args.push("-c", "notify=[]");
    for (const name of await configuredMcpServerNames(this.codexHome)) {
      const key = /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name);
      args.push("-c", `mcp_servers.${key}.enabled=false`);
    }
    for (const override of this.options.configOverrides ?? []) args.push("-c", override);
    args.push("app-server", "--stdio");
    return args;
  }

  private async start(): Promise<void> {
    this.stopping = false;
    const env: NodeJS.ProcessEnv = { ...process.env, RUST_LOG: process.env["RUST_LOG"] ?? "error" };
    // The whole point of this proxy is the ChatGPT login; never let an API key leak into Codex.
    for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"]) delete env[key];
    const args = await this.buildArgs();
    this.logger.info("starting codex app-server", { bin: this.options.bin, disabled: (this.options.disabledFeatures ?? DEFAULT_DISABLED_FEATURES).join(",") });
    const child = spawn(this.options.bin, args, { cwd: this.options.workspace, env, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    this.startedAt = Date.now();
    child.stdin.on("error", (error) => this.logger.debug("stdin error", { error: String(error) }));
    const stderr = createInterface({ input: child.stderr });
    stderr.on("line", (line) => { if (line.trim()) this.logger.debug("codex stderr", { line: line.slice(0, 400) }); });
    const stdout = createInterface({ input: child.stdout });
    stdout.on("line", (line) => this.receive(line));
    child.once("exit", (code, signal) => this.handleExit(child, code, signal));

    const spawned = new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", (error) => reject(new Error(`Could not start "${this.options.bin}": ${error.message}. Is Codex CLI installed and on PATH?`)));
    });
    await spawned;
    const init = await this.request<JsonObject>("initialize", {
      clientInfo: { name: "codex_proxy", title: "Codex Proxy", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    }, 30_000);
    this.userAgent = typeof init["userAgent"] === "string" ? init["userAgent"] : null;
    this.send({ method: "initialized" });
    try {
      const read = await this.request<JsonObject>("account/read", { refreshToken: false }, 15_000);
      const account = (read["account"] ?? {}) as JsonObject;
      this.account = {
        type: typeof account["type"] === "string" ? account["type"] : null,
        email: typeof account["email"] === "string" ? account["email"] : null,
        planType: typeof account["planType"] === "string" ? account["planType"] : null,
      };
    } catch (error) {
      this.account = { type: null, email: null, planType: null };
      this.logger.warn("could not read the Codex account", { error: String(error) });
    }
    if (this.account.type !== "chatgpt") {
      this.logger.warn("Codex is not logged in with ChatGPT; run `codex login` on this machine", { type: this.account.type });
    } else {
      this.logger.info("codex ready", { account: this.account.type, plan: this.account.planType, agent: this.userAgent });
    }
  }

  private handleExit(child: ChildProcessByStdio<Writable, Readable, Readable>, code: number | null, signal: NodeJS.Signals | null) {
    if (this.child !== child) return;
    this.child = null;
    this.logger.warn("codex app-server exited", { code, signal, stopping: this.stopping });
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new RpcError(`Codex exited before answering ${pending.method}.`));
    }
    this.pending.clear();
    const params: JsonObject = { code, signal };
    for (const [threadID, handlers] of this.threadHandlers) {
      for (const handler of handlers) {
        try { handler(CODEX_EXITED, { ...params, threadId: threadID }); } catch (error) { this.logger.error("handler failed", { error: String(error) }); }
      }
    }
    this.threadHandlers.clear();
  }

  private send(message: JsonObject) {
    if (!this.child || this.child.exitCode !== null) throw new RpcError("Codex is not running.");
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  private receive(line: string) {
    let message: JsonObject;
    try {
      message = JSON.parse(line) as JsonObject;
    } catch {
      this.logger.debug("non-JSON line from codex", { line: line.slice(0, 200) });
      return;
    }
    const hasID = message["id"] !== undefined && message["id"] !== null;
    const method = typeof message["method"] === "string" ? message["method"] : null;
    if (hasID && !method) {
      const pending = this.pending.get(Number(message["id"]));
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(Number(message["id"]));
      const error = message["error"] as JsonObject | undefined;
      if (error) pending.reject(new RpcError(typeof error["message"] === "string" ? error["message"] : "Codex rejected the request.", typeof error["code"] === "number" ? error["code"] : null, error["data"]));
      else pending.resolve(message["result"]);
      return;
    }
    if (hasID && method) {
      // Server-to-client requests are approvals and tool prompts. The proxy never executes anything.
      this.logger.debug("rejecting server request", { method });
      this.send({ id: message["id"], error: { code: -32601, message: "codex-proxy does not execute tools, commands or approvals." } });
      return;
    }
    if (!method) return;
    const params = (message["params"] ?? {}) as JsonObject;
    const threadID = typeof params["threadId"] === "string" ? params["threadId"] : null;
    if (threadID) {
      for (const handler of this.threadHandlers.get(threadID) ?? []) {
        try { handler(method, params); } catch (error) { this.logger.error("thread handler failed", { method, error: String(error) }); }
      }
    }
    for (const handler of this.globalHandlers) {
      try { handler(method, params); } catch (error) { this.logger.error("global handler failed", { method, error: String(error) }); }
    }
  }

  async request<T = unknown>(method: string, params: JsonObject, timeoutMs = 30_000): Promise<T> {
    if (method !== "initialize") await this.ensure();
    this.serial += 1;
    const id = this.serial;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError(`Codex did not answer ${method} within ${Math.round(timeoutMs / 1000)}s.`));
      }, timeoutMs);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer, method });
      try {
        this.send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  subscribe(threadID: string, handler: NotificationHandler): () => void {
    let handlers = this.threadHandlers.get(threadID);
    if (!handlers) {
      handlers = new Set();
      this.threadHandlers.set(threadID, handlers);
    }
    handlers.add(handler);
    return () => {
      const current = this.threadHandlers.get(threadID);
      current?.delete(handler);
      if (current && current.size === 0) this.threadHandlers.delete(threadID);
    };
  }

  onAny(handler: NotificationHandler): () => void {
    this.globalHandlers.add(handler);
    return () => { this.globalHandlers.delete(handler); };
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    child.stdin.end();
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, 2_000));
    await Promise.race([exited, timeout]);
    if (child.exitCode === null) child.kill("SIGTERM");
    this.child = null;
  }
}
