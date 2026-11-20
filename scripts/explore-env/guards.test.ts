/**
 * The guards of the disposable environments (#536) that need no server: which processes `down`
 * may signal, which manifests it trusts, which files the web server serves, which PostgreSQL
 * servers it accepts, which directories hold secrets, and which origins the Keycloak bootstrap
 * takes.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { assertExploreServerUrl } from "./instance.ts";
import { readManifest } from "./manifest.ts";
import { assertPrivate, ensurePrivateDir } from "./private-dir.ts";
import { isRunProcess } from "./processes.ts";
import { resolveRequestPath } from "./static-paths.ts";

const BOOTSTRAP_SH = fileURLToPath(new URL("../keycloak/bootstrap.sh", import.meta.url));

describe("isRunProcess", () => {
  const marker = "envelope-explore-0a1b2c3d";

  it("accepts the run's API and web server", () => {
    assert.ok(isRunProcess(["/usr/bin/node", "/repo/apps/api/src/main.ts", marker], marker));
    assert.ok(isRunProcess(["/usr/bin/node", "/repo/scripts/explore-env/static-server.ts", "/tmp/r/web", "0", marker], marker));
  });

  it("refuses another run's process, an unrelated one, or a marker that is only part of an argument", () => {
    assert.ok(!isRunProcess(["/usr/bin/node", "/repo/apps/api/src/main.ts", "envelope-explore-ffffffff"], marker));
    assert.ok(!isRunProcess(["/usr/bin/node", "/repo/scripts/explore-env/cli.ts", "down", marker], marker));
    assert.ok(!isRunProcess(["/usr/bin/node", "/repo/apps/api/src/main.ts", `--x=${marker}`], marker));
    assert.ok(!isRunProcess([], marker));
  });
});

describe("resolveRequestPath", () => {
  const root = "/srv/web";

  it("maps a request path inside the root", () => {
    assert.equal(resolveRequestPath(root, "/"), "/srv/web");
    assert.equal(resolveRequestPath(root, "/assets/app.js"), "/srv/web/assets/app.js");
    assert.equal(resolveRequestPath(root, "/a/../index.html"), "/srv/web/index.html");
  });

  it("never leaves the root, encoded or not", () => {
    for (const attempt of ["/../etc/passwd", "/..%2f..%2fetc/passwd", "/%2e%2e/%2e%2e/etc/passwd", "/assets/../../web-other/x"]) {
      const resolved = resolveRequestPath(root, attempt);
      assert.ok(resolved === undefined || resolved === root || resolved.startsWith(`${root}/`), `${attempt} -> ${resolved}`);
    }
  });

  it("refuses an undecodable path and a NUL byte", () => {
    assert.equal(resolveRequestPath(root, "/%E0%A4%A"), undefined);
    assert.equal(resolveRequestPath(root, "/index.html%00.js"), undefined);
  });
});

describe("assertExploreServerUrl", () => {
  it("accepts a local server on its own port", () => {
    assertExploreServerUrl("postgres://explore_admin:pw@127.0.0.1:55432/postgres");
    assertExploreServerUrl("postgres://explore_admin:pw@localhost:55432/postgres");
  });

  it("refuses port 5432, a missing port and a remote host", () => {
    assert.throws(() => assertExploreServerUrl("postgres://envelope:pw@127.0.0.1:5432/envelope"), /port 5432/);
    assert.throws(() => assertExploreServerUrl("postgres://envelope:pw@127.0.0.1/envelope"), /5432 \(the default\)/);
    assert.throws(() => assertExploreServerUrl("postgres://envelope:pw@db.example.com:55432/x"), /non-local/);
  });
});

describe("private directories and manifests", () => {
  let base: string;

  before(async () => {
    base = await mkdtemp(path.join(tmpdir(), "envelope-explore-test-"));
  });

  after(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("creates a private directory and refuses a shared or symlinked one", async () => {
    const dir = path.join(base, "root");
    await ensurePrivateDir(dir);
    await assertPrivate(dir, "directory");
    const open = path.join(base, "open");
    await mkdir(open);
    await chmod(open, 0o755);
    await assert.rejects(assertPrivate(open, "directory"), /mode 755/);
    const link = path.join(base, "link");
    await symlink(dir, link);
    await assert.rejects(ensurePrivateDir(link), /symbolic link/);
  });

  async function manifestAt(dirName: string, content: unknown): Promise<string> {
    const dir = path.join(base, "runs", dirName);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    const file = path.join(dir, "manifest.json");
    await writeFile(file, JSON.stringify(content), { mode: 0o600 });
    return file;
  }

  const good = { run: "0a1b2c3d", database: "envelope_explore_0a1b2c3d", keycloak: { realm: "envelope-explore-0a1b2c3d" } };

  it("reads a manifest whose names are its run's own, in its run's directory", async () => {
    const manifest = await readManifest(await manifestAt("0a1b2c3d", good));
    assert.equal(manifest.run, "0a1b2c3d");
  });

  it("refuses a manifest naming the shared database or realm, another run's names, or a run that is not a string", async () => {
    await assert.rejects(readManifest(await manifestAt("0a1b2c3d", { ...good, database: "envelope" })), /Refusing to touch database "envelope"/);
    await assert.rejects(readManifest(await manifestAt("0a1b2c3d", { ...good, keycloak: { realm: "envelope" } })), /Refusing to touch realm "envelope"/);
    await assert.rejects(readManifest(await manifestAt("0a1b2c3d", { ...good, database: "envelope_explore_ffffffff" })), /do not belong to run/);
    await assert.rejects(readManifest(await manifestAt("0a1b2c3d", { ...good, run: ["0a1b2c3d"] })), /"run" is not a string/);
  });

  it("refuses a manifest outside a directory named after its run", async () => {
    await assert.rejects(readManifest(await manifestAt("ffffffff", good)), /not in a directory named after its run/);
  });
});

describe("scripts/keycloak/bootstrap.sh origins", () => {
  /** Runs the script against a port nothing listens on; resolves with its exit code and output, or "waiting" once it gets past validation. */
  function bootstrap(env: Record<string, string>): Promise<{ result: number | "waiting"; output: string }> {
    return new Promise((resolve) => {
      const child = spawn("bash", [BOOTSTRAP_SH], {
        env: { PATH: process.env.PATH ?? "", KEYCLOAK_URL: "http://127.0.0.1:9", KEYCLOAK_ADMIN_PASSWORD: "unused", ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      const onData = (chunk: Buffer): void => {
        output += chunk.toString();
        if (output.includes("== Waiting for Keycloak")) {
          child.kill("SIGKILL");
          resolve({ result: "waiting", output });
        }
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.once("exit", (code) => resolve({ result: code ?? -1, output }));
    });
  }

  it("refuses an origin with a path, a wildcard, a query, a user or no scheme", async () => {
    for (const origin of [
      "http://127.0.0.1:4000/app",
      "http://127.0.0.1:*",
      "127.0.0.1:4000",
      "javascript:alert(1)",
      "http://b?x",
      "http://127.0.0.1@evil.example",
      "http://127.0.0.1:123456",
    ]) {
      const { result, output } = await bootstrap({ ENVELOPE_BOOTSTRAP_REALM: "envelope-explore-0a1b2c3d", ENVELOPE_BOOTSTRAP_WEB_ORIGINS: origin });
      assert.equal(result, 1, origin);
      assert.match(output, /Refusing origin/);
    }
  });

  it("refuses custom origins for the shared realm", async () => {
    const { result, output } = await bootstrap({ ENVELOPE_BOOTSTRAP_WEB_ORIGINS: "http://127.0.0.1:4000" });
    assert.equal(result, 1);
    assert.match(output, /shared "envelope" realm/);
  });

  it("refuses any realm but envelope or a disposable one", async () => {
    for (const realm of ["master", "envelope-test", "envelope-explore-0A1B2C3D", "envelope-explore-0a1b2c3d9"]) {
      const { result, output } = await bootstrap({ ENVELOPE_BOOTSTRAP_REALM: realm });
      assert.equal(result, 1, realm);
      assert.match(output, /Refusing realm/);
    }
  });

  it("never glob-expands an origin", async () => {
    // "*" would expand to the names of the files in the current directory if it were globbed.
    const { result, output } = await bootstrap({ ENVELOPE_BOOTSTRAP_REALM: "envelope-explore-0a1b2c3d", ENVELOPE_BOOTSTRAP_WEB_ORIGINS: "*" });
    assert.equal(result, 1);
    assert.match(output, /Refusing origin "\*"/);
  });

  it("accepts plain origins for another realm", async () => {
    const { result } = await bootstrap({
      ENVELOPE_BOOTSTRAP_REALM: "envelope-explore-0a1b2c3d",
      ENVELOPE_BOOTSTRAP_WEB_ORIGINS: "http://127.0.0.1:4000 https://localhost:4443 http://[::1]:4000",
    });
    assert.equal(result, "waiting");
  });
});
