import type { LogLevel } from "./config.ts";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

function format(fields: Record<string, unknown> | undefined): string {
  if (!fields) return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const text = typeof value === "string" ? value : JSON.stringify(value);
    parts.push(`${key}=${text}`);
  }
  return parts.length ? " " + parts.join(" ") : "";
}

export function createLogger(level: LogLevel, scope = "proxy", sink: (line: string) => void = (line) => process.stderr.write(line + "\n")): Logger {
  const threshold = ORDER[level];
  function emit(kind: LogLevel, message: string, fields?: Record<string, unknown>) {
    if (ORDER[kind] < threshold) return;
    const stamp = new Date().toISOString();
    sink(`${stamp} ${kind.padEnd(5)} [${scope}] ${message}${format(fields)}`);
  }
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    child: (name) => createLogger(level, `${scope}:${name}`, sink),
  };
}
