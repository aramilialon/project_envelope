/**
 * The installer's only tool (#777): a stdio MCP server (`installer-sandbox` in .mcp.json) with one
 * tool, `run`, that runs a shell command inside the sandbox container and nowhere else:
 *
 *   docker exec -i -u <root|dev> -w <home> envelope-installer-sandbox timeout -k 10 <s> bash -lic <command>
 *
 * starting in the user's home directory, in an interactive login shell, as a real user's terminal
 * would: the lines a manual adds to `~/.bashrc` take effect in the next call (Debian's `.bashrc`
 * returns early in a non-interactive shell). Without a terminal, that shell prints two harmless
 * lines on stderr at startup; they are dropped (`isStartupNoise`). `timeout` runs inside the
 * sandbox, so a stopped command does not keep running there after the client gives up.
 *
 * It refuses unless that container exists, runs and carries the label envelope.installer=1; the
 * Docker client gets a minimal environment, never the host's; a command is stopped after at most
 * 30 minutes; the output returned is the last 20,000 characters; and every call is appended to a
 * transcript outside the repository (`transcriptPath`). It speaks the MCP stdio transport
 * (newline-delimited JSON-RPC 2.0) itself, so it needs no dependency.
 */
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { CONTAINER, LABEL_KEY, NETWORK, type SandboxUser, transcriptPath, USERS } from "./sandbox.ts";

export const TOOL_NAME = "run";
export const DEFAULT_TIMEOUT_S = 600;
export const MAX_TIMEOUT_S = 1800;
export const OUTPUT_LIMIT = 20_000;
const KILL_GRACE_S = 10;

export type ExecResult = { code: number | null; output: string; timedOut: boolean };
/** Runs the Docker client; injected in tests. `timeoutMs` is a backstop for the client itself. */
export type Exec = (args: readonly string[], timeoutMs: number) => Promise<ExecResult>;

/** The Docker client's whole environment: no variable of the host's reaches it or the sandbox. */
export const CLIENT_ENV = {
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  HOME: "/nonexistent",
  DOCKER_CONFIG: "/nonexistent/.docker",
} as const;

/**
 * The lines an interactive bash prints on stderr when it has no terminal: harmless, and the same
 * on every call. Only these exact lines are dropped; anything else on stderr is kept.
 */
const STARTUP_NOISE = [/^bash: cannot set terminal process group \(-?\d+\): Inappropriate ioctl for device$/, /^bash: no job control in this shell$/];

export function isStartupNoise(line: string): boolean {
  return STARTUP_NOISE.some((pattern) => pattern.test(line));
}

/** Keeps stderr's complete lines, without the startup noise; `flush` returns what is left at the end. */
export function stderrFilter(): { push: (text: string) => string; flush: () => string } {
  let pending = "";
  return {
    push(text) {
      pending += text;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      return lines.filter((line) => !isStartupNoise(line)).map((line) => `${line}\n`).join("");
    },
    flush() {
      const rest = isStartupNoise(pending) ? "" : pending;
      pending = "";
      return rest;
    },
  };
}

export const dockerExec: Exec = (args, timeoutMs) =>
  new Promise((resolve) => {
    const child = spawn("docker", args, { env: { ...CLIENT_ENV }, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    const append = (text: string) => {
      output += text;
      if (output.length > OUTPUT_LIMIT * 4) output = output.slice(-OUTPUT_LIMIT * 2);
    };
    const stderr = stderrFilter();
    child.stdout.on("data", (chunk: Buffer) => append(chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => append(stderr.push(chunk.toString("utf8"))));
    child.stdin.end();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      append(stderr.flush());
      resolve({ code: null, output: `${output}${error.message}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      append(stderr.flush());
      resolve({ code, output, timedOut });
    });
  });

export type RunInput = { command: string; user: SandboxUser; timeout_s: number };

/** Validates the tool's arguments; returns an error message instead of throwing. */
export function parseRunInput(raw: unknown): RunInput | string {
  if (typeof raw !== "object" || raw === null) return "arguments must be an object";
  const { command, user, timeout_s } = raw as Record<string, unknown>;
  if (typeof command !== "string" || command.trim() === "") return "command must be a non-empty string";
  if (typeof user !== "string" || !(USERS as readonly string[]).includes(user)) return `user must be one of ${USERS.join(", ")}`;
  const timeout = timeout_s === undefined ? DEFAULT_TIMEOUT_S : timeout_s;
  if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_S) {
    return `timeout_s must be a whole number of seconds from 1 to ${MAX_TIMEOUT_S}`;
  }
  return { command, user: user as SandboxUser, timeout_s: timeout };
}

export const HOMES: Record<SandboxUser, string> = { root: "/root", dev: "/home/dev" };

export function runArgs(input: RunInput): string[] {
  return ["exec", "-i", "-u", input.user, "-w", HOMES[input.user], CONTAINER, "timeout", "-k", String(KILL_GRACE_S), String(input.timeout_s), "bash", "-lic", input.command];
}

export const INSPECT_FORMAT = `{{.State.Running}}|{{index .Config.Labels "${LABEL_KEY}"}}|{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}`;

/**
 * Refuses unless the sandbox container exists, runs, carries the installer label and is attached
 * to the sandbox's network and no other (the host firewall covers that network's bridge only).
 */
export async function checkSandbox(exec: Exec): Promise<string | null> {
  const inspected = await exec(["inspect", "--type", "container", "--format", INSPECT_FORMAT, CONTAINER], 30_000);
  if (inspected.code !== 0) return `The sandbox container ${CONTAINER} does not exist. Ask the coordinator to bring it up.`;
  const [running, label, networks = ""] = inspected.output.trim().split("|");
  if (label !== "1") return `The container ${CONTAINER} is not the installer sandbox (label ${LABEL_KEY}=1 missing); refusing to run in it.`;
  if (running !== "true") return `The sandbox container ${CONTAINER} is not running. Ask the coordinator to bring it up.`;
  const attached = networks.split(" ").filter(Boolean);
  if (attached.length !== 1 || attached[0] !== NETWORK) {
    return `The container ${CONTAINER} is attached to ${attached.join(", ") || "no network"}, not only to ${NETWORK}; refusing to run in it.`;
  }
  return null;
}

export function tail(text: string, limit: number = OUTPUT_LIMIT): string {
  if (text.length <= limit) return text;
  return `[… ${text.length - limit} earlier characters trimmed …]\n${text.slice(-limit)}`;
}

export type Sandbox = { exec: Exec; record: (entry: string) => void; now?: () => Date };

export type ToolResult = { content: { type: "text"; text: string }[]; isError: boolean };

export async function runTool(sandbox: Sandbox, raw: unknown): Promise<ToolResult> {
  const input = parseRunInput(raw);
  if (typeof input === "string") return { content: [{ type: "text", text: input }], isError: true };
  const refusal = await checkSandbox(sandbox.exec);
  const started = (sandbox.now ?? (() => new Date()))();
  if (refusal !== null) {
    sandbox.record(`--- ${started.toISOString()} refused (${input.user})\n$ ${input.command}\n${refusal}\n`);
    return { content: [{ type: "text", text: refusal }], isError: true };
  }
  const result = await sandbox.exec(runArgs(input), (input.timeout_s + KILL_GRACE_S + 30) * 1000);
  // `timeout` exits with 124 when it stops the command; the client backstop sets timedOut.
  const status = result.timedOut || result.code === 124 ? `stopped after ${input.timeout_s} s` : `exit ${result.code ?? "none"}`;
  const output = tail(result.output);
  const seconds = Math.round(((sandbox.now ?? (() => new Date()))().getTime() - started.getTime()) / 1000);
  sandbox.record(`--- ${started.toISOString()} ${input.user} (${status}, ${seconds} s)\n$ ${input.command}\n${output}\n`);
  return { content: [{ type: "text", text: `[${status}]\n${output}` }], isError: result.code !== 0 };
}

export const TOOL = {
  name: TOOL_NAME,
  description:
    "Runs one shell command inside the installer's sandbox, a Debian 13 machine, in a fresh interactive login shell (`bash -lic`, so ~/.bashrc is read) as root or as the user dev, and returns its exit status and the last 20,000 characters of its output. Nothing runs outside the sandbox.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command, run with bash -lic." },
      user: { type: "string", enum: [...USERS], description: "root for the manual's `#` commands, dev for its `$` commands." },
      timeout_s: { type: "integer", minimum: 1, maximum: MAX_TIMEOUT_S, description: `Seconds before the command is stopped (default ${DEFAULT_TIMEOUT_S}).` },
    },
    required: ["command", "user"],
    additionalProperties: false,
  },
} as const;

type Request = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Record<string, unknown> };

/** Handles one JSON-RPC message; returns the response, or null for a notification. */
export async function handleMessage(sandbox: Sandbox, message: Request): Promise<object | null> {
  const isRequest = message.id !== undefined && message.id !== null;
  const reply = (result: object) => ({ jsonrpc: "2.0", id: message.id, result });
  const fail = (code: number, text: string) => ({ jsonrpc: "2.0", id: message.id, error: { code, message: text } });
  switch (message.method) {
    case "initialize": {
      const requested = message.params?.protocolVersion;
      return reply({
        protocolVersion: typeof requested === "string" ? requested : "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "installer-sandbox", version: "0.0.0" },
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: [TOOL] });
    case "tools/call": {
      if (message.params?.name !== TOOL_NAME) return fail(-32602, `Unknown tool ${String(message.params?.name)}`);
      return reply(await runTool(sandbox, message.params.arguments));
    }
    default:
      return isRequest ? fail(-32601, `Method not found: ${message.method}`) : null;
  }
}

function main(): void {
  const file = transcriptPath();
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const sandbox: Sandbox = { exec: dockerExec, record: (entry) => appendFileSync(file, entry, { mode: 0o600 }) };
  const send = (response: object | null) => {
    if (response !== null) process.stdout.write(`${JSON.stringify(response)}\n`);
  };
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    if (line.trim() === "") return;
    let message: Request;
    try {
      message = JSON.parse(line) as Request;
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    if (typeof message !== "object" || message === null || Array.isArray(message)) {
      send({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
      return;
    }
    handleMessage(sandbox, message).then(send, (error: unknown) =>
      send({ jsonrpc: "2.0", id: message.id ?? null, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } }),
    );
  });
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
