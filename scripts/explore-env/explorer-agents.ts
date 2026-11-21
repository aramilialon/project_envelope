/**
 * The explorer agents (#646): one per persona, each bound to its own Playwright MCP server, so the
 * three can run at the same time without sharing a browser. Their instructions are kept once, in
 * `explorer-instructions.md` (the agents have no Read tool, so the text is written into each
 * definition); this module renders `.claude/agents/explorer-<persona>.md` from it, and
 * `explorer-agents.test.ts` fails when a definition, `.mcp.json` or the deny list in
 * `.claude/settings.json` drifts from what is here.
 *
 *   node explore-env/explorer-agents.ts     # rewrites the three definitions
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const PERSONAS = ["household", "investor", "mixed"] as const;
export type Persona = (typeof PERSONAS)[number];

const PERSONA_TITLE: Record<Persona, string> = {
  household: "household",
  investor: "investor",
  mixed: "mixed household",
};

const PERSONA_SCOPE: Record<Persona, string> = {
  household: "a monthly envelope budget",
  investor: "an investment portfolio",
  mixed: "a household that budgets and invests, above all where the two meet",
};

/**
 * Each persona's standing charter (#737), covered every release besides what the release changed,
 * so that the three explorers do not walk the same flows. It completes the sentence "you cover …".
 */
export const PERSONA_CHARTER: Record<Persona, string> = {
  household:
    "the permission matrix (what the owner, the editor and the reader can and cannot do on every screen you reach) and the credit card flows (spending on a card, paying it, overspending with it, and moving money to cover it).",
  investor:
    "trades and the positions they produce (buys, sells to zero, splits, transfers of securities, edits and deletes), closing an account that still holds money or securities, and the net-worth rules (what counts, as of which day).",
  mixed:
    "transfers between budget and investment accounts, closed accounts (what can and cannot still reach them, through every screen and import), and every place where the budget meets the portfolio (funding the brokerage account through a category, dividends and fees on its cash, net worth across both).",
};

/** The browser tools an explorer may use, in the order its definition lists them. */
export const EXPLORER_TOOLS = [
  "browser_navigate",
  "browser_navigate_back",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_fill_form",
  "browser_select_option",
  "browser_press_key",
  "browser_hover",
  "browser_wait_for",
  "browser_handle_dialog",
  "browser_take_screenshot",
  "browser_console_messages",
  "browser_network_requests",
  "browser_evaluate",
  "browser_tabs",
  "browser_resize",
  "browser_close",
] as const;

/** Server tools nobody needs, denied for every explorer server in `.claude/settings.json`. */
export const DENIED_TOOLS = [
  "browser_run_code_unsafe",
  "browser_file_upload",
  "browser_drop",
  "browser_network_request",
] as const;

export function agentName(persona: Persona): string {
  return `explorer-${persona}`;
}

export function serverName(persona: Persona): string {
  return `playwright-${persona}`;
}

export function toolName(persona: Persona, tool: string): string {
  return `mcp__${serverName(persona)}__${tool}`;
}

export function agentPath(persona: Persona): string {
  return path.join(REPO_ROOT, ".claude", "agents", `${agentName(persona)}.md`);
}

/** The `.mcp.json` entry that starts a persona's server. */
export function serverConfig(persona: Persona): { command: string; args: string[] } {
  return {
    command: "sh",
    args: [
      "-c",
      `exec sh "$(git rev-parse --show-toplevel)/scripts/explore-env/playwright-mcp.sh" ${persona}`,
    ],
  };
}

export function renderAgent(persona: Persona, instructions: string): string {
  const description =
    `Uses the app like a real person, without the source code, on a disposable environment, as the ` +
    `${PERSONA_TITLE[persona]} persona (${PERSONA_SCOPE[persona]}). Follows realistic and deliberately odd ` +
    `flows and returns reproducible findings with their evidence. Runs before a release, after the ` +
    `milestone's issues are merged, at the same time as the other explorers. Has a browser of its own ` +
    `and nothing else.`;
  const tools = EXPLORER_TOOLS.map((tool) => toolName(persona, tool)).join(", ");
  const body = instructions
    .replaceAll("{{persona}}", PERSONA_TITLE[persona])
    .replaceAll("{{charter}}", PERSONA_CHARTER[persona]);
  return [
    "---",
    `name: ${agentName(persona)}`,
    `description: ${description}`,
    `tools: ${tools}`,
    "---",
    "",
    "<!-- Generated from scripts/explore-env/explorer-instructions.md by scripts/explore-env/explorer-agents.ts; edit those, not this file. -->",
    "",
    body,
  ].join("\n");
}

export function readInstructions(): string {
  return readFileSync(path.join(REPO_ROOT, "scripts", "explore-env", "explorer-instructions.md"), "utf8");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const instructions = readInstructions();
  for (const persona of PERSONAS) {
    writeFileSync(agentPath(persona), renderAgent(persona, instructions));
    console.log(`wrote ${path.relative(REPO_ROOT, agentPath(persona))}`);
  }
}
