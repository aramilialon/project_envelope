/**
 * Starts the real compiled server (main.ts) as a subprocess and waits for it
 * to accept real HTTP connections. Smoke tests use this instead of
 * buildApp()+inject() to prove the process itself works end to end —
 * config parsing, listen()'s host/port binding, staying up — not just its
 * handlers (ADR 0007).
 *
 * The server listens on port 0, so the operating system picks a free port and
 * two runs on one machine never collide (#519); the actual address is read
 * back from the server's own "Server listening at ..." log line, which is why
 * `LOG_LEVEL` is always `info` and `LOG_PRETTY` always off here.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const MAIN_TS = fileURLToPath(new URL("../main.ts", import.meta.url));
const APPS_API_DIR = fileURLToPath(new URL("../..", import.meta.url));
const READY_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 5_000;
const LISTENING_LINE = /"msg":"Server listening at (http:\/\/[^"]+)"/;

export interface RunningServer {
  readonly baseUrl: string;
  stop(): Promise<void>;
}

export async function startServer(env: Record<string, string>): Promise<RunningServer> {
  const child = spawn(process.execPath, [MAIN_TS], {
    cwd: APPS_API_DIR,
    env: { ...process.env, PORT: "0", ...env, LOG_LEVEL: "info", LOG_PRETTY: "false" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const output: string[] = [];
  child.stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => output.push(chunk.toString()));

  const baseUrl = await waitUntilReady(child, output);

  return {
    baseUrl,
    stop: () => stopServer(child),
  };
}

async function waitUntilReady(child: ChildProcess, output: string[]): Promise<string> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Server process exited before becoming ready:\n${output.join("")}`);
    }
    const baseUrl = LISTENING_LINE.exec(output.join(""))?.[1];
    if (baseUrl) {
      try {
        await fetch(`${baseUrl}/health`);
        return baseUrl;
      } catch {
        // Listening, but not answering yet: try again below.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill("SIGKILL");
  throw new Error(`Server did not become ready within ${READY_TIMEOUT_MS}ms:\n${output.join("")}`);
}

async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const timedOut = await Promise.race([
    exited.then(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), STOP_TIMEOUT_MS)),
  ]);
  if (timedOut) {
    child.kill("SIGKILL");
    await exited;
  }
}
