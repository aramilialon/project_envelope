/**
 * The long-running processes of a disposable environment (#536): started detached, in a process
 * group of their own, with their output in a log file in the run directory, so they outlive the
 * `up` command that started them. Each is started on port 0 and prints one
 * `{"msg":"listening",…}` line, read back from its log. `stopProcess` checks the PID still runs a
 * command line carrying the run's marker before signalling it, so a PID the system has reused
 * since is never killed.
 */
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";

const READY_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 5_000;

export function startDetached(command: string, args: readonly string[], options: { cwd: string; env: Record<string, string>; logFile: string }): number {
  const fd = openSync(options.logFile, "a", 0o600);
  try {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, detached: true, stdio: ["ignore", fd, fd] });
    if (child.pid === undefined) {
      throw new Error(`Could not start ${command}`);
    }
    child.unref();
    return child.pid;
  } finally {
    closeSync(fd);
  }
}

export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Resolves with `http://127.0.0.1:<port>` once the process logs its listening line. */
export async function waitForListening(pid: number, logFile: string): Promise<string> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const text = await readFile(logFile, "utf8").catch(() => "");
    for (const line of text.split("\n")) {
      if (line.startsWith('{"msg":"listening"')) {
        const { address, port } = JSON.parse(line) as { address: string; port: number };
        return `http://${address.includes(":") ? `[${address}]` : address}:${port}`;
      }
    }
    if (!isRunning(pid)) {
      throw new Error(`Process ${pid} exited before listening; see ${logFile}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Process ${pid} did not start listening within ${READY_TIMEOUT_MS} ms; see ${logFile}`);
}

async function commandLine(pid: number): Promise<string[] | undefined> {
  try {
    return (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0");
  } catch {
    return undefined;
  }
}

/**
 * Stops `pid` (and its process group) if it still runs and is one of the run's own processes
 * (`isRunProcess`).
 * Returns what it did; never throws for a process that is already gone.
 */
export async function stopProcess(pid: number, marker: string): Promise<"stopped" | "not running" | "not ours"> {
  if (!isRunning(pid)) {
    return "not running";
  }
  const cmdline = await commandLine(pid);
  if (cmdline === undefined) {
    // No /proc (not Linux): nothing to check the PID against, so leave it alone.
    return isRunning(pid) ? "not ours" : "not running";
  }
  if (!isRunProcess(cmdline, marker)) {
    return "not ours";
  }
  const signal = (sig: NodeJS.Signals): void => {
    try {
      process.kill(-pid, sig);
    } catch {
      try {
        process.kill(pid, sig);
      } catch {
        // Already gone.
      }
    }
  };
  signal("SIGTERM");
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (isRunning(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (isRunning(pid)) {
    signal("SIGKILL");
  }
  return "stopped";
}

/** The entry points a run's own long-running processes are started from. */
const ENTRY_POINTS = ["explore-env/static-server.ts", "apps/api/src/main.ts"];

/** A process started from one of `ENTRY_POINTS` with `marker` among its arguments. */
function isRunProcess(args: readonly string[], marker: string): boolean {
  return args.includes(marker) && args.some((arg) => ENTRY_POINTS.some((entryPoint) => arg.endsWith(entryPoint)));
}

/**
 * PIDs of a run's own processes found by their command line (Linux only: an empty list
 * elsewhere): a process started from one of `ENTRY_POINTS` with `marker` among its arguments.
 * Finds them even when the manifest that listed them is gone.
 */
export async function findRunProcesses(marker: string): Promise<number[]> {
  const entries = await readdir("/proc").catch(() => [] as string[]);
  const found: number[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) {
      continue;
    }
    const args = (await commandLine(Number(entry))) ?? [];
    if (isRunProcess(args, marker)) {
      found.push(Number(entry));
    }
  }
  return found;
}

/** Runs a command to completion with its output appended to `logFile`. */
export async function runToLog(command: string, args: readonly string[], options: { cwd: string; env: Record<string, string>; logFile: string }): Promise<void> {
  const fd = openSync(options.logFile, "a", 0o600);
  try {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", fd, fd] });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    if (code !== 0) {
      throw new Error(`${command} ${args.join(" ")} failed (exit ${code}); see ${options.logFile}`);
    }
  } finally {
    closeSync(fd);
  }
}
