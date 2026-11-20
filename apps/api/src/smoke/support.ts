/**
 * Starts the real compiled server (main.ts) as a subprocess and waits for it
 * to accept real HTTP connections. Smoke tests use this instead of
 * buildApp()+inject() to prove the process itself works end to end —
 * config parsing, listen()'s host/port binding, staying up — not just its
 * handlers (ADR 0007).
 *
 * The server listens on port 0 unless a test says otherwise, so the operating
 * system picks a free port and two runs on one machine never collide (#519).
 * A production server refuses PORT=0, so for NODE_ENV=production this asks the
 * system for a free port first and passes it explicitly (a port another
 * process could take in between, a far smaller window than a fixed one).
 * main.ts prints one `{"msg":"listening","address":…,"port":…}` line once it
 * is listening, whatever LOG_LEVEL says; this resolves on that line.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

const MAIN_TS = fileURLToPath(new URL("../main.ts", import.meta.url));
const APPS_API_DIR = fileURLToPath(new URL("../..", import.meta.url));
const READY_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 5_000;
/** How much of the server's own output is kept, only to report a failure to start. */
const OUTPUT_CAP_CHARS = 64 * 1024;

export interface RunningServer {
  readonly baseUrl: string;
  stop(): Promise<void>;
}

export async function startServer(env: Record<string, string>): Promise<RunningServer> {
  const port = env.NODE_ENV === "production" ? String(await freePort()) : "0";
  const child = spawn(process.execPath, [MAIN_TS], {
    cwd: APPS_API_DIR,
    env: { ...process.env, PORT: port, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    const baseUrl = await waitUntilListening(child);
    return { baseUrl, stop: () => stopServer(child) };
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }
}

function waitUntilListening(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    let pendingLine = "";

    const record = (chunk: string): void => {
      output = (output + chunk).slice(-OUTPUT_CAP_CHARS);
    };
    const finish = (settle: () => void): void => {
      clearTimeout(timer);
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      child.off("exit", onExit);
      // Keep draining the pipes once nobody reads them, so a chatty server never blocks on a full one.
      child.stdout?.resume();
      child.stderr?.resume();
      settle();
    };
    const onStdout = (chunk: Buffer): void => {
      const text = chunk.toString();
      record(text);
      const lines = (pendingLine + text).split("\n");
      pendingLine = lines.pop() ?? "";
      for (const line of lines) {
        const baseUrl = listeningUrl(line);
        if (baseUrl) {
          finish(() => resolve(baseUrl));
          return;
        }
      }
    };
    const onStderr = (chunk: Buffer): void => record(chunk.toString());
    const onExit = (): void =>
      finish(() => reject(new Error(`Server process exited before becoming ready:\n${output}`)));
    const timer = setTimeout(
      () => finish(() => reject(new Error(`Server did not become ready within ${READY_TIMEOUT_MS}ms:\n${output}`))),
      READY_TIMEOUT_MS,
    );

    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.once("exit", onExit);
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

function listeningUrl(line: string): string | undefined {
  if (!line.startsWith('{"msg":"listening"')) {
    return undefined;
  }
  const { address, port } = JSON.parse(line) as { address: string; port: number };
  const host = address.includes(":") ? `[${address}]` : address;
  return `http://${host}:${port}`;
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
