/**
 * The installer's sandbox (#777): a privileged Debian 13 container with systemd and a Docker
 * Engine of its own, on its own bridge, kept off the private networks by a host firewall. The
 * `installer` agent reaches it only through `sandbox-mcp.ts`. See scripts/README.md ("Installer
 * sandbox").
 *
 *   node install-env/cli.ts firewall-on    # once per host (root): rules plus a systemd unit that keeps them
 *   node install-env/cli.ts up             # builds the image, starts the sandbox, prints the passwords
 *   node install-env/cli.ts status
 *   node install-env/cli.ts down           # removes the container, its volumes, network and image
 *   node install-env/cli.ts firewall-off   # removes the rules and the unit (refused while a sandbox exists)
 */
import { randomBytes } from "node:crypto";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, existsSync, rmSync, statfsSync, writeFileSync } from "node:fs";

import {
  BRIDGE,
  CONTAINER,
  FIREWALL_SCRIPT,
  FIREWALL_UNIT,
  FIREWALL_UNIT_PATH,
  firewallScript,
  firewallUnit,
  IMAGE,
  IMAGE_DIR,
  isSandboxNetwork,
  LABEL,
  MIN_FREE_BYTES,
  NETWORK,
  networkCreateArgs,
  NETWORK_INSPECT_FORMAT,
  sandboxRunArgs,
  USERS,
  VOLUMES,
} from "./sandbox.ts";

const SYSTEM_READY_TIMEOUT_S = 120;

function run(command: string, args: readonly string[], options: { input?: string; inherit?: boolean } = {}): SpawnSyncReturns<string> {
  return spawnSync(command, args, {
    encoding: "utf8",
    input: options.input,
    stdio: options.inherit ? ["ignore", "inherit", "inherit"] : ["pipe", "pipe", "pipe"],
  });
}

function must(command: string, args: readonly string[], options: { input?: string; inherit?: boolean } = {}): string {
  const result = run(command, args, options);
  if (result.status !== 0) {
    throw new Error(`${command} ${args[0] ?? ""} failed: ${(result.stderr ?? "").trim() || `exit ${result.status}`}`);
  }
  return result.stdout ?? "";
}

function containerLabel(): string | null {
  const result = run("docker", ["inspect", "--type", "container", "--format", '{{index .Config.Labels "envelope.installer"}}', CONTAINER]);
  return result.status === 0 ? result.stdout.trim() : null;
}

function firewallActive(): boolean {
  return existsSync(FIREWALL_SCRIPT) && run(FIREWALL_SCRIPT, ["check"]).status === 0;
}

function requireRoot(): void {
  if (process.getuid?.() !== 0) throw new Error("This command changes the host firewall: run it as root.");
}

function up(): void {
  if (containerLabel() !== null) throw new Error(`${CONTAINER} already exists: run down first.`);
  if (!firewallActive()) throw new Error("The host firewall for the sandbox is not active: run firewall-on first (as root).");
  const dockerRoot = must("docker", ["info", "--format", "{{.DockerRootDir}}"]).trim();
  const fs = statfsSync(dockerRoot);
  const free = fs.bavail * fs.bsize;
  if (free < MIN_FREE_BYTES) {
    throw new Error(`Only ${(free / 1024 ** 3).toFixed(1)} GB free under ${dockerRoot}; the sandbox needs at least ${MIN_FREE_BYTES / 1024 ** 3} GB.`);
  }

  console.log(`Building ${IMAGE}…`);
  must("docker", ["build", "--quiet", "--label", LABEL, "--tag", IMAGE, IMAGE_DIR]);
  if (run("docker", ["network", "inspect", NETWORK]).status !== 0) must("docker", networkCreateArgs());
  const network = must("docker", ["network", "inspect", "--format", NETWORK_INSPECT_FORMAT, NETWORK]);
  if (!isSandboxNetwork(network)) {
    throw new Error(
      `The network ${NETWORK} exists but is not the sandbox's (bridge and label "${network.trim()}", expected "${BRIDGE} 1"): ` +
        "the firewall would not cover it. Remove it (docker network rm) and run up again.",
    );
  }
  for (const volume of Object.keys(VOLUMES)) must("docker", ["volume", "create", "--label", LABEL, volume]);
  must("docker", sandboxRunArgs());

  // `systemctl` cannot answer until systemd has started its bus: retry until it reports a state.
  const deadline = Date.now() + SYSTEM_READY_TIMEOUT_S * 1000;
  let state = "";
  while (state === "" && Date.now() < deadline) {
    const ready = run("docker", ["exec", CONTAINER, "timeout", String(SYSTEM_READY_TIMEOUT_S), "systemctl", "is-system-running", "--wait"]);
    state = (ready.stdout ?? "").trim();
    if (state === "") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  }
  if (state !== "running") console.warn(`systemd reports "${state || "no state"}"; check with: docker exec ${CONTAINER} systemctl --failed`);

  const passwords = USERS.map((user) => [user, randomBytes(9).toString("base64url")] as const);
  must("docker", ["exec", "-i", CONTAINER, "chpasswd"], { input: passwords.map(([user, password]) => `${user}:${password}\n`).join("") });

  console.log(`${CONTAINER} is up (systemd: ${state || "unknown"}).`);
  console.log("Passwords for the installer's brief (they exist only inside the sandbox):");
  for (const [user, password] of passwords) console.log(`  ${user}: ${password}`);
}

function down(): void {
  const label = containerLabel();
  if (label !== null && label !== "1") throw new Error(`${CONTAINER} exists but is not the installer sandbox; leaving it alone.`);
  if (label === "1") must("docker", ["rm", "--force", "--volumes", CONTAINER]);
  for (const volume of must("docker", ["volume", "ls", "--quiet", "--filter", `label=${LABEL}`]).split("\n").filter(Boolean)) {
    must("docker", ["volume", "rm", volume]);
  }
  for (const network of must("docker", ["network", "ls", "--quiet", "--filter", `label=${LABEL}`]).split("\n").filter(Boolean)) {
    must("docker", ["network", "rm", network]);
  }
  if (run("docker", ["image", "inspect", IMAGE]).status === 0) must("docker", ["image", "rm", IMAGE]);
  console.log("The installer sandbox, its volumes, network and image are gone.");
}

/** The size of each of the sandbox's volumes, as `docker system df -v` reports it; empty when there is none. */
function volumeSizes(): string {
  const listed = run("docker", ["system", "df", "-v", "--format", "{{json .Volumes}}"]);
  if (listed.status !== 0) return "unknown";
  const volumes = JSON.parse(listed.stdout || "[]") as { Name?: string; Labels?: string; Size?: string }[] | null;
  return (volumes ?? [])
    .filter((volume) => volume.Name !== undefined && volume.Name in VOLUMES && (volume.Labels ?? "").split(",").includes(LABEL))
    .map((volume) => `${volume.Name} ${volume.Size ?? "?"}`)
    .join(", ");
}

function status(): void {
  const container = run("docker", ["inspect", "--type", "container", "--format", "{{.State.Status}} (started {{.State.StartedAt}})", CONTAINER]);
  console.log(`container: ${container.status === 0 ? container.stdout.trim() : "none"}`);
  console.log(`volumes:   ${must("docker", ["volume", "ls", "--quiet", "--filter", `label=${LABEL}`]).split("\n").filter(Boolean).join(", ") || "none"}`);
  const sizes = volumeSizes();
  if (sizes !== "") console.log(`disk:      ${sizes} (run down right after a run)`);
  console.log(`network:   ${must("docker", ["network", "ls", "--quiet", "--filter", `label=${LABEL}`]).trim() ? NETWORK : "none"}`);
  console.log(`firewall:  ${firewallActive() ? "active" : "not active"}`);
}

function firewallOn(): void {
  requireRoot();
  writeFileSync(FIREWALL_SCRIPT, firewallScript(), { mode: 0o755 });
  chmodSync(FIREWALL_SCRIPT, 0o755);
  writeFileSync(FIREWALL_UNIT_PATH, firewallUnit(), { mode: 0o644 });
  must("systemctl", ["daemon-reload"]);
  must("systemctl", ["enable", FIREWALL_UNIT]);
  must("systemctl", ["restart", FIREWALL_UNIT]);
  if (!firewallActive()) throw new Error("The firewall rules did not apply; see: journalctl -u " + FIREWALL_UNIT);
  console.log(`Firewall active, and re-applied by ${FIREWALL_UNIT} whenever Docker starts.`);
}

function firewallOff(): void {
  requireRoot();
  if (containerLabel() !== null) throw new Error(`${CONTAINER} still exists: run down first.`);
  run("systemctl", ["disable", "--now", FIREWALL_UNIT]);
  if (existsSync(FIREWALL_SCRIPT)) run(FIREWALL_SCRIPT, ["off"]);
  rmSync(FIREWALL_UNIT_PATH, { force: true });
  rmSync(FIREWALL_SCRIPT, { force: true });
  must("systemctl", ["daemon-reload"]);
  console.log("Firewall rules and unit removed.");
}

const commands: Record<string, () => void> = { up, down, status, "firewall-on": firewallOn, "firewall-off": firewallOff };
const command = commands[process.argv[2] ?? ""];
if (command === undefined) {
  console.error(`usage: node install-env/cli.ts ${Object.keys(commands).join("|")}`);
  process.exit(64);
}
try {
  command();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
