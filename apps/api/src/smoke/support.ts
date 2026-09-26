/**
 * Starts the real compiled server (main.ts) as a subprocess and waits for it
 * to accept real HTTP connections. Smoke tests use this instead of
 * buildApp()+inject() to prove the process itself works end to end —
 * config parsing, listen()'s host/port binding, staying up — not just its
 * handlers (ADR 0007).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const MAIN_TS = fileURLToPath(new URL("../main.ts", import.meta.url));
const APPS_API_DIR = fileURLToPath(new URL("../..", import.meta.url));
const READY_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 5_000;

export interface RunningServer {
  readonly baseUrl: string;
  stop(): Promise<void>;
}

export async function startServer(env: Record<string, string>): Promise<RunningServer> {
  const host = env.HOST ?? "127.0.0.1";
  const port = env.PORT ?? "3000";
  const baseUrl = `http://${host}:${port}`;

  const child = spawn(process.execPath, [MAIN_TS], {
    cwd: APPS_API_DIR,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const output: string[] = [];
  child.stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => output.push(chunk.toString()));

  await waitUntilReady(baseUrl, child, output);

  return {
    baseUrl,
    stop: () => stopServer(child),
  };
}

async function waitUntilReady(baseUrl: string, child: ChildProcess, output: string[]): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Server process exited before becoming ready:\n${output.join("")}`);
    }
    try {
      await fetch(`${baseUrl}/health`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  child.kill("SIGKILL");
  throw new Error(`Server did not become ready within ${READY_TIMEOUT_MS}ms at ${baseUrl}:\n${output.join("")}`);
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
