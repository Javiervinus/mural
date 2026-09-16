import { networkInterfaces } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";

export type ThinkingMode = "buffer" | "flush-on-quiet" | "immediate";
/** How Codex hands the agent's answer back to the live model after a voice handoff. */
export type HandoffMode = "commentary" | "thinking";
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface ProxyConfig {
  host: string;
  port: number;
  token: string | null;
  codexBin: string;
  liveModel: string;
  defaultVoice: string;
  textModel: string;
  textEffort: string;
  thinkingMode: ThinkingMode;
  handoffMode: HandoffMode;
  quietSeconds: number;
  maxSessionMinutes: number;
  clientGraceSeconds: number;
  corsOrigins: string[];
  dataDir: string;
  logLevel: LogLevel;
}

const PREFIX = "CODEX_PROXY_";

function read(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[PREFIX + key];
  return value === undefined || value.trim() === "" ? undefined : value.trim();
}

function readNumber(env: NodeJS.ProcessEnv, key: string, fallback: number, minimum: number, maximum: number): number {
  const raw = read(env, key);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${PREFIX}${key} must be a number between ${minimum} and ${maximum}, got "${raw}".`);
  }
  return value;
}

function readChoice<T extends string>(env: NodeJS.ProcessEnv, key: string, choices: readonly T[], fallback: T): T {
  const raw = read(env, key);
  if (raw === undefined) return fallback;
  if (!(choices as readonly string[]).includes(raw)) {
    throw new Error(`${PREFIX}${key} must be one of ${choices.join(", ")}, got "${raw}".`);
  }
  return raw as T;
}

function expandHome(path: string): string {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ProxyConfig {
  return {
    host: read(env, "HOST") ?? "127.0.0.1",
    port: readNumber(env, "PORT", 8790, 1, 65535),
    token: read(env, "TOKEN") ?? null,
    codexBin: read(env, "CODEX_BIN") ?? "codex",
    liveModel: read(env, "LIVE_MODEL") ?? "gpt-live-1-codex",
    defaultVoice: read(env, "DEFAULT_VOICE") ?? "cove",
    textModel: read(env, "TEXT_MODEL") ?? "gpt-5.6-luna",
    textEffort: read(env, "TEXT_EFFORT") ?? "low",
    thinkingMode: readChoice(env, "THINKING", ["buffer", "flush-on-quiet", "immediate"] as const, "buffer"),
    handoffMode: readChoice(env, "HANDOFF", ["commentary", "thinking"] as const, "commentary"),
    quietSeconds: readNumber(env, "QUIET_SECONDS", 8, 2, 120),
    maxSessionMinutes: readNumber(env, "MAX_SESSION_MINUTES", 60, 1, 24 * 60),
    clientGraceSeconds: readNumber(env, "CLIENT_GRACE_SECONDS", 90, 5, 3600),
    corsOrigins: (read(env, "CORS_ORIGINS") ?? "*").split(",").map((s) => s.trim()).filter(Boolean),
    dataDir: expandHome(read(env, "DATA_DIR") ?? "~/.config/codex-proxy"),
    logLevel: readChoice(env, "LOG_LEVEL", ["debug", "info", "warn", "error"] as const, "info"),
  };
}

/** Tailscale hands out IPv4 addresses inside the carrier-grade NAT range 100.64.0.0/10. */
export function isTailscaleAddress(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127;
}

export type InterfaceTable = Record<string, Array<{ address: string; family: string | number; internal: boolean }> | undefined>;

export function findTailscaleAddress(table: InterfaceTable = networkInterfaces() as InterfaceTable): string | null {
  for (const entries of Object.values(table)) {
    for (const entry of entries ?? []) {
      const isV4 = entry.family === "IPv4" || entry.family === 4;
      if (isV4 && !entry.internal && isTailscaleAddress(entry.address)) return entry.address;
    }
  }
  return null;
}

/** Turns the configured host into a concrete bind address. */
export function resolveBindHost(host: string, table?: InterfaceTable): string {
  if (host !== "tailscale") return host;
  const address = findTailscaleAddress(table);
  if (!address) {
    throw new Error("CODEX_PROXY_HOST=tailscale but no Tailscale IPv4 address (100.64.0.0/10) was found on this machine. Is Tailscale running?");
  }
  return address;
}
