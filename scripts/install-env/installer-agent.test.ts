import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { type Exec, type ExecResult, handleMessage, isStartupNoise, MAX_TIMEOUT_S, OUTPUT_LIMIT, runArgs, runTool, type Sandbox, stderrFilter } from "./sandbox-mcp.ts";
import { BLOCKED_RANGES, BRIDGE, CONTAINER, firewallScript, isSandboxNetwork, LABEL, NETWORK, networkCreateArgs, REPO_ROOT, sandboxRunArgs, transcriptPath } from "./sandbox.ts";

const SERVER = "installer-sandbox";
const TOOL = `mcp__${SERVER}__run`;

function readJson(relative: string): unknown {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, relative), "utf8"));
}

/** An injected Docker client: answers `inspect` with the given state and label, and records every call. */
function fakeDocker(inspect: ExecResult, run: ExecResult = { code: 0, output: "ok\n", timedOut: false }) {
  const calls: (readonly string[])[] = [];
  const exec: Exec = async (args) => {
    calls.push(args);
    return args[0] === "inspect" ? inspect : run;
  };
  const records: string[] = [];
  const sandbox: Sandbox = { exec, record: (entry) => records.push(entry) };
  return { calls, records, sandbox };
}

const RUNNING_LABELLED: ExecResult = { code: 0, output: `true|1|${NETWORK} \n`, timedOut: false };

describe("installer agent (one sandbox tool)", () => {
  it("gives the installer the sandbox's run tool and nothing else", () => {
    const definition = readFileSync(path.join(REPO_ROOT, ".claude", "agents", "installer.md"), "utf8");
    assert.equal(/^tools: (.*)$/m.exec(definition)?.[1], TOOL);
    assert.match(definition, /^name: installer$/m);
  });

  it("keeps the sandbox tool from every other agent: qa lists it, the rest list tools without it or disallow it", () => {
    const dir = path.join(REPO_ROOT, ".claude", "agents");
    const files = readdirSync(dir).filter((file) => file.endsWith(".md"));
    assert.ok(files.length > 2);
    for (const file of files) {
      const frontmatter = /^---\n([\s\S]*?)\n---/.exec(readFileSync(path.join(dir, file), "utf8"))?.[1] ?? "";
      const list = (key: string) => {
        const value = new RegExp(`^${key}: (.*)$`, "m").exec(frontmatter)?.[1];
        return value === undefined ? undefined : value.split(",").map((tool) => tool.trim());
      };
      const tools = list("tools");
      const disallowed = list("disallowedTools") ?? [];
      if (file === "installer.md") continue;
      if (file === "qa.md") {
        assert.ok(tools?.includes(TOOL), "qa replays installer findings through the sandbox tool");
        continue;
      }
      if (tools === undefined) assert.ok(disallowed.includes(TOOL), `${file} has no tools list and does not disallow ${TOOL}`);
      else assert.ok(!tools.includes(TOOL) && !tools.some((tool) => tool.startsWith(`mcp__${SERVER}`)), `${file} lists the sandbox tool`);
    }
  });

  it("starts the sandbox server from .mcp.json and allows only its run tool", () => {
    const config = readJson(".mcp.json") as { mcpServers: Record<string, unknown> };
    assert.deepEqual(config.mcpServers[SERVER], {
      command: "sh",
      args: ["-c", 'exec node "$(git rev-parse --show-toplevel)/scripts/install-env/sandbox-mcp.ts"'],
    });
    const settings = readJson(".claude/settings.json") as { permissions: { allow: string[] } };
    assert.deepEqual(
      settings.permissions.allow.filter((rule) => rule.includes(SERVER)),
      [TOOL],
    );
    // The confinement is the tools list, never a Bash allow rule (#777).
    assert.deepEqual(
      settings.permissions.allow.filter((rule) => rule.startsWith("Bash(") && /docker|install-env/i.test(rule)),
      [],
    );
  });
});

describe("installer sandbox container", () => {
  const args = sandboxRunArgs();
  const joined = args.join(" ");

  it("mounts no host path and no Docker socket", () => {
    assert.ok(!args.some((arg) => arg === "-v" || arg === "--volume" || arg.startsWith("--volume=") || arg.startsWith("-v=")), "uses -v/--volume");
    for (const [index, arg] of args.entries()) {
      if (arg !== "--mount") continue;
      const spec = args[index + 1] ?? "";
      assert.match(spec, /^type=volume,src=envelope-installer-[a-z]+,dst=\/var\/lib\/(docker|containerd)$/, spec);
    }
    assert.ok(!joined.includes("docker.sock"), "mentions docker.sock");
    assert.ok(!joined.includes("type=bind"), "has a bind mount");
  });

  it("shares no host namespace and publishes no port", () => {
    for (const flag of ["--network=host", "--net=host", "--pid", "--ipc", "--uts", "--userns", "-p", "--publish", "-P", "--publish-all", "--device", "--env-file", "-e", "--env"]) {
      assert.ok(!args.some((arg) => arg === flag || arg.startsWith(`${flag}=`)), `uses ${flag}`);
    }
    assert.equal(args[args.indexOf("--network") + 1], "envelope-installer-net");
    assert.ok(!args.includes("host"));
  });

  it("reuses an existing network only when it has the firewalled bridge and the label", () => {
    assert.ok(isSandboxNetwork(`${BRIDGE} 1\n`));
    assert.ok(!isSandboxNetwork(" 1\n"), "default bridge name");
    assert.ok(!isSandboxNetwork("br-other 1\n"));
    assert.ok(!isSandboxNetwork(`${BRIDGE} \n`), "no label");
    const cli = readFileSync(path.join(REPO_ROOT, "scripts", "install-env", "cli.ts"), "utf8");
    assert.match(cli, /if \(!isSandboxNetwork\(network\)\)/, "up checks the network before starting the container");
  });

  it("is labelled, limited and on its own bridge", () => {
    assert.ok(args.includes("--cgroupns=private"));
    assert.equal(args[args.indexOf("--label") + 1], LABEL);
    assert.equal(args[args.indexOf("--name") + 1], CONTAINER);
    assert.equal(args[args.indexOf("--cpus") + 1], "2");
    assert.equal(args[args.indexOf("--memory") + 1], "4g");
    assert.equal(args[args.indexOf("--pids-limit") + 1], "4096");
    assert.ok(networkCreateArgs().includes(`com.docker.network.bridge.name=${BRIDGE}`));
    assert.ok(BRIDGE.length <= 15, "a Linux interface name has at most 15 characters");
  });

  it("drops every private range from its bridge, and everything to the host", () => {
    const script = firewallScript();
    for (const range of BLOCKED_RANGES) assert.match(script, new RegExp(`-d ${range.replace(/[./]/g, "\\$&")} -j DROP`));
    assert.match(script, /iptables -I DOCKER-USER 1 -i "\$bridge"/);
    assert.match(script, /iptables -I INPUT 1 -i "\$bridge"/);
    assert.match(script, /ip6tables -I FORWARD 1 -i "\$bridge"/);
    assert.match(script, /ip6tables -I INPUT 1 -i "\$bridge"/);
  });
});

describe("installer sandbox MCP server", () => {
  it("refuses a container without the installer label, and runs nothing", async () => {
    const docker = fakeDocker({ code: 0, output: `true||${NETWORK} \n`, timedOut: false });
    const result = await runTool(docker.sandbox, { command: "id", user: "root" });
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? "", /not the installer sandbox/);
    assert.equal(docker.calls.length, 1);
    assert.equal(docker.calls[0]?.[0], "inspect");
  });

  it("refuses when the container is missing or stopped", async () => {
    const missing = fakeDocker({ code: 1, output: "Error: No such container", timedOut: false });
    assert.match((await runTool(missing.sandbox, { command: "id", user: "dev" })).content[0]?.text ?? "", /does not exist/);
    const stopped = fakeDocker({ code: 0, output: "false|1|\n", timedOut: false });
    assert.match((await runTool(stopped.sandbox, { command: "id", user: "dev" })).content[0]?.text ?? "", /not running/);
    assert.equal(missing.calls.length + stopped.calls.length, 2);
  });

  it("refuses a container attached to another network, or to more than its own", async () => {
    for (const networks of ["bridge ", `${NETWORK} bridge `, ""]) {
      const docker = fakeDocker({ code: 0, output: `true|1|${networks}\n`, timedOut: false });
      const result = await runTool(docker.sandbox, { command: "id", user: "root" });
      assert.equal(result.isError, true, networks);
      assert.match(result.content[0]?.text ?? "", /not only to envelope-installer-net/);
      assert.equal(docker.calls.length, 1, networks);
    }
  });

  it("runs only docker exec in the sandbox, as the chosen user, with a capped timeout", async () => {
    const docker = fakeDocker(RUNNING_LABELLED);
    const result = await runTool(docker.sandbox, { command: "uname -a; id", user: "dev", timeout_s: 60 });
    assert.equal(result.isError, false);
    assert.deepEqual(docker.calls[1], ["exec", "-i", "-u", "dev", "-w", "/home/dev", CONTAINER, "timeout", "-k", "10", "60", "bash", "-lic", "uname -a; id"]);
    assert.deepEqual(runArgs({ command: "x", user: "root", timeout_s: 5 }).slice(0, 7), ["exec", "-i", "-u", "root", "-w", "/root", CONTAINER]);
    assert.match(docker.records[0] ?? "", /\$ uname -a; id/);
  });

  it("drops only the interactive shell's startup noise from stderr, even split across chunks", () => {
    assert.ok(isStartupNoise("bash: cannot set terminal process group (-1): Inappropriate ioctl for device"));
    assert.ok(isStartupNoise("bash: no job control in this shell"));
    assert.ok(!isStartupNoise("bash: no job control in this shell, really"));
    assert.ok(!isStartupNoise("bash: fnm: command not found"));
    const filter = stderrFilter();
    const kept =
      filter.push("bash: cannot set terminal process group (-1): Inappro") +
      filter.push("priate ioctl for device\nbash: no job control in this shell\nE: Unable to locate package x\n") +
      filter.push("warning without newline") +
      filter.flush();
    assert.equal(kept, "E: Unable to locate package x\nwarning without newline");
  });

  it("rejects another user, an empty command and a timeout above the cap", async () => {
    for (const input of [
      { command: "id", user: "admin" },
      { command: "  ", user: "root" },
      { command: "id", user: "root", timeout_s: MAX_TIMEOUT_S + 1 },
      { command: "id", user: "root", timeout_s: 0 },
      null,
    ]) {
      const docker = fakeDocker(RUNNING_LABELLED);
      const result = await runTool(docker.sandbox, input);
      assert.equal(result.isError, true, JSON.stringify(input));
      assert.equal(docker.calls.length, 0, JSON.stringify(input));
    }
  });

  it("returns only the tail of a long output, and reports a stopped command", async () => {
    const long = `${"a".repeat(30_000)}END`;
    const docker = fakeDocker(RUNNING_LABELLED, { code: 124, output: long, timedOut: false });
    const text = (await runTool(docker.sandbox, { command: "yes", user: "root", timeout_s: 1 })).content[0]?.text ?? "";
    assert.ok(text.startsWith("[stopped after 1 s]"));
    assert.ok(text.endsWith("END"));
    assert.ok(text.length < OUTPUT_LIMIT + 200);
  });

  it("speaks MCP: initialize, tools/list with the one tool, unknown tools refused", async () => {
    const docker = fakeDocker(RUNNING_LABELLED);
    const init = (await handleMessage(docker.sandbox, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })) as {
      result: { protocolVersion: string };
    };
    assert.equal(init.result.protocolVersion, "2025-06-18");
    assert.equal(await handleMessage(docker.sandbox, { jsonrpc: "2.0", method: "notifications/initialized" }), null);
    const list = (await handleMessage(docker.sandbox, { jsonrpc: "2.0", id: 2, method: "tools/list" })) as { result: { tools: { name: string }[] } };
    assert.deepEqual(list.result.tools.map((tool) => tool.name), ["run"]);
    const other = (await handleMessage(docker.sandbox, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "shell", arguments: {} } })) as {
      error?: unknown;
    };
    assert.ok(other.error);
    assert.equal(docker.calls.length, 0);
  });

  it("writes its transcript outside the repository", () => {
    assert.ok(transcriptPath({}).startsWith(path.join(os.tmpdir(), "envelope-installer")));
    assert.throws(() => transcriptPath({ ENVELOPE_INSTALLER_TRANSCRIPT: path.join(REPO_ROOT, "transcript.log") }), /inside the repository/);
    assert.throws(() => transcriptPath({ ENVELOPE_INSTALLER_TRANSCRIPT: path.join(REPO_ROOT, "scripts", "x.log") }), /inside the repository/);
    assert.equal(transcriptPath({ ENVELOPE_INSTALLER_TRANSCRIPT: "/var/tmp/i.log" }), "/var/tmp/i.log");
  });
});
