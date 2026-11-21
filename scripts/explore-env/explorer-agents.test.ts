import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import {
  agentName,
  agentPath,
  DENIED_TOOLS,
  EXPLORER_TOOLS,
  PERSONAS,
  readInstructions,
  renderAgent,
  REPO_ROOT,
  serverConfig,
  serverName,
  toolName,
} from "./explorer-agents.ts";

function readJson(relative: string): unknown {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, relative), "utf8"));
}

describe("explorer agents (one browser each)", () => {
  it("keeps every definition in step with the shared instructions", () => {
    const instructions = readInstructions();
    for (const persona of PERSONAS) {
      assert.equal(
        readFileSync(agentPath(persona), "utf8"),
        renderAgent(persona, instructions),
        `${agentName(persona)}.md is out of date: run node scripts/explore-env/explorer-agents.ts`,
      );
    }
  });

  it("gives each explorer only its own server's tools and nothing else", () => {
    const instructions = readInstructions();
    for (const persona of PERSONAS) {
      const tools = /^tools: (.*)$/m.exec(renderAgent(persona, instructions))?.[1]?.split(", ");
      assert.deepEqual(
        tools,
        EXPLORER_TOOLS.map((tool) => `mcp__${serverName(persona)}__${tool}`),
      );
    }
    const offered: readonly string[] = EXPLORER_TOOLS;
    for (const denied of DENIED_TOOLS) assert.ok(!offered.includes(denied), `${denied} is offered`);
  });

  it("leaves no other explorer definition behind", () => {
    const explorers = readdirSync(path.join(REPO_ROOT, ".claude", "agents"))
      .filter((file) => file.startsWith("explorer"))
      .sort();
    assert.deepEqual(explorers, PERSONAS.map((persona) => `${agentName(persona)}.md`).sort());
  });

  it("starts one server per explorer, and no other Playwright server", () => {
    const config = readJson(".mcp.json") as { mcpServers: Record<string, unknown> };
    const playwright = Object.keys(config.mcpServers).filter((name) => name.startsWith("playwright"));
    assert.deepEqual(playwright.sort(), PERSONAS.map(serverName).sort());
    for (const persona of PERSONAS) {
      assert.deepEqual(config.mcpServers[serverName(persona)], serverConfig(persona));
    }
  });

  it("denies the unneeded tools on every explorer server, and allows none", () => {
    const settings = readJson(".claude/settings.json") as {
      permissions: { deny: string[]; allow?: string[]; ask?: string[] };
    };
    for (const persona of PERSONAS) {
      for (const tool of DENIED_TOOLS) {
        assert.ok(settings.permissions.deny.includes(toolName(persona, tool)), `${toolName(persona, tool)} is not denied`);
      }
    }
    for (const rule of [...(settings.permissions.allow ?? []), ...(settings.permissions.ask ?? [])]) {
      assert.ok(!rule.startsWith("mcp__"), `unexpected rule ${rule}`);
    }
  });
});
