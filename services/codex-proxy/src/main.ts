import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CodexClient } from "./codex.ts";
import { loadConfig, resolveBindHost } from "./config.ts";
import { createLogger } from "./log.ts";
import { createProxyServer, PROXY_VERSION } from "./server.ts";

async function loadOrCreateToken(dataDir: string, configured: string | null): Promise<{ token: string; generated: boolean }> {
  if (configured) return { token: configured, generated: false };
  const file = join(dataDir, "token");
  try {
    const existing = (await readFile(file, "utf8")).trim();
    if (existing) return { token: existing, generated: false };
  } catch {
    // First start: create one.
  }
  const token = randomBytes(24).toString("base64url");
  await writeFile(file, token + "\n", { mode: 0o600 });
  return { token, generated: true };
}

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const workspace = join(config.dataDir, "workspace");
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  const { token, generated } = await loadOrCreateToken(config.dataDir, config.token);
  const bindHost = resolveBindHost(config.host);

  const codex = new CodexClient({ bin: config.codexBin, workspace, logger: logger.child("codex") });
  const { server, sessions } = createProxyServer({ config, codex, logger, token });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, bindHost, () => { server.off("error", reject); resolve(); });
  });

  const base = `http://${bindHost}:${config.port}`;
  logger.info(`codex-proxy ${PROXY_VERSION} listening`, { url: base + "/v1", host: config.host === "tailscale" ? `tailscale (${bindHost})` : bindHost });
  process.stderr.write([
    "",
    "  Codex proxy is ready.",
    `  Base URL : ${base}/v1`,
    `  Token    : ${token}${generated ? "   (generated and stored in " + config.dataDir + "/token)" : ""}`,
    `  Health   : ${base}/healthz`,
    "",
    "  In the Mural app choose “Codex on my Mac”, paste the base URL and the token.",
    "",
  ].join("\n"));

  codex.ensure().catch((error) => logger.error("codex failed to start; it will be retried on the first request", { error: String(error) }));

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("shutting down", { signal, sessions: sessions.size });
    server.close();
    await sessions.closeAll("proxy_shutdown");
    await codex.stop();
    process.exit(0);
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void shutdown(signal); });
}

main().catch((error: unknown) => {
  process.stderr.write(`codex-proxy could not start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
