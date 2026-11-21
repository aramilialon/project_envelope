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
 *
 * The server's stdout and stderr are kept for its whole life, the last
 * `OUTPUT_CAP_CHARS` of them, so a test that fails can show what the server
 * logged (`printServerOutputOnFailure`): a 500 in a test only says that the
 * server failed, its log says why (#585).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

const MAIN_TS = fileURLToPath(new URL("../main.ts", import.meta.url));
const APPS_API_DIR = fileURLToPath(new URL("../..", import.meta.url));
const READY_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 5_000;
/** How much of the server's own output is kept (the most recent part), to report a failure. */
const OUTPUT_CAP_CHARS = 64 * 1024;

export interface RunningServer {
  readonly baseUrl: string;
  /** The last `OUTPUT_CAP_CHARS` characters the server wrote to stdout and stderr, interleaved. */
  output(): string;
  stop(): Promise<void>;
}

/**
 * An `afterEach` hook that prints the output of `servers()` when the test that just ran failed:
 * `afterEach(printServerOutputOnFailure(() => [server]))`. Servers not started yet are skipped.
 */
export function printServerOutputOnFailure(
  servers: () => ReadonlyArray<RunningServer | undefined>,
): (context: { readonly name: string }) => void {
  return (context) => {
    // Node.js gives an `afterEach` hook the test's own context, whose `passed` (Node.js 22.16+ and
    // 24) the installed type definitions do not declare yet.
    if ((context as { readonly passed?: boolean }).passed !== false) {
      return;
    }
    for (const server of servers()) {
      if (server) {
        console.error(`--- output of the server at ${server.baseUrl} (test "${context.name}" failed) ---\n${server.output()}--- end of server output ---`);
      }
    }
  };
}

export async function startServer(env: Record<string, string>): Promise<RunningServer> {
  const port = env.NODE_ENV === "production" ? String(await freePort()) : "0";
  const child = spawn(process.execPath, [MAIN_TS], {
    cwd: APPS_API_DIR,
    env: { ...process.env, PORT: port, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  const record = (chunk: Buffer): void => {
    output = (output + chunk.toString()).slice(-OUTPUT_CAP_CHARS);
  };
  // Listening for "data" for the server's whole life also keeps both pipes drained, so a chatty
  // server never blocks on a full one.
  child.stdout.on("data", record);
  child.stderr.on("data", record);

  try {
    const baseUrl = await waitUntilListening(child, () => output);
    return { baseUrl, output: () => output, stop: () => stopServer(child) };
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }
}

function waitUntilListening(child: ChildProcess, output: () => string): Promise<string> {
  return new Promise((resolve, reject) => {
    let pendingLine = "";

    const finish = (settle: () => void): void => {
      clearTimeout(timer);
      child.stdout?.off("data", onStdout);
      child.off("exit", onExit);
      settle();
    };
    const onStdout = (chunk: Buffer): void => {
      const text = chunk.toString();
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
    const onExit = (): void =>
      finish(() => reject(new Error(`Server process exited before becoming ready:\n${output()}`)));
    const timer = setTimeout(
      () => finish(() => reject(new Error(`Server did not become ready within ${READY_TIMEOUT_MS}ms:\n${output()}`))),
      READY_TIMEOUT_MS,
    );

    child.stdout?.on("data", onStdout);
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
