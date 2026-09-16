import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findTailscaleAddress, isTailscaleAddress, loadConfig, resolveBindHost } from "../src/config.ts";
import { mcpServerNamesFromToml } from "../src/codex.ts";
import { bearerMatches } from "../src/server.ts";

describe("loadConfig", () => {
  it("uses safe defaults", () => {
    const config = loadConfig({});
    assert.equal(config.host, "127.0.0.1");
    assert.equal(config.port, 8790);
    assert.equal(config.token, null);
    assert.equal(config.liveModel, "gpt-live-1-codex");
    assert.equal(config.thinkingMode, "buffer");
    assert.equal(config.handoffMode, "commentary");
    assert.deepEqual(config.corsOrigins, ["*"]);
  });
  it("reads and validates overrides", () => {
    const config = loadConfig({ CODEX_PROXY_PORT: "9000", CODEX_PROXY_THINKING: "immediate", CODEX_PROXY_HANDOFF: "thinking", CODEX_PROXY_CORS_ORIGINS: "http://a, http://b", CODEX_PROXY_DATA_DIR: "~/x" });
    assert.equal(config.port, 9000);
    assert.equal(config.thinkingMode, "immediate");
    assert.equal(config.handoffMode, "thinking");
    assert.deepEqual(config.corsOrigins, ["http://a", "http://b"]);
    assert.ok(config.dataDir.endsWith("/x") && !config.dataDir.startsWith("~"));
    assert.throws(() => loadConfig({ CODEX_PROXY_PORT: "abc" }));
    assert.throws(() => loadConfig({ CODEX_PROXY_THINKING: "loud" }));
    assert.throws(() => loadConfig({ CODEX_PROXY_HANDOFF: "silent" }));
  });
});

describe("tailscale detection", () => {
  it("recognises the CGNAT range", () => {
    assert.equal(isTailscaleAddress("100.64.0.1"), true);
    assert.equal(isTailscaleAddress("100.127.255.254"), true);
    assert.equal(isTailscaleAddress("100.128.0.1"), false);
    assert.equal(isTailscaleAddress("192.168.1.2"), false);
  });
  it("finds the address among interfaces and resolves the bind host", () => {
    const table = {
      lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
      en0: [{ address: "192.168.100.10", family: "IPv4", internal: false }],
      utun4: [{ address: "100.101.102.103", family: "IPv4", internal: false }, { address: "fd7a::1", family: "IPv6", internal: false }],
    };
    assert.equal(findTailscaleAddress(table), "100.101.102.103");
    assert.equal(resolveBindHost("tailscale", table), "100.101.102.103");
    assert.equal(resolveBindHost("0.0.0.0", table), "0.0.0.0");
    assert.throws(() => resolveBindHost("tailscale", { lo0: table.lo0 }));
  });
});

describe("codex helpers", () => {
  it("lists configured MCP server names from config.toml", () => {
    const toml = `[mcp_servers.pencil]\ncommand = "x"\n\n[mcp_servers.node_repl.env]\nA = "1"\n[mcp_servers."chrome devtools"]\nurl = "y"\n[mcp_servers.chrome-devtools-2]\n`;
    assert.deepEqual(mcpServerNamesFromToml(toml), ["pencil", "chrome devtools", "chrome-devtools-2"]);
  });
  it("compares bearer tokens safely", () => {
    assert.equal(bearerMatches("Bearer abc", "abc"), true);
    assert.equal(bearerMatches("Bearer abd", "abc"), false);
    assert.equal(bearerMatches("abc", "abc"), false);
    assert.equal(bearerMatches(undefined, "abc"), false);
  });
});
