/**
 * Serves a built `apps/web` (`vite build`'s output) for a disposable environment (#536): plain
 * files from one directory, with `index.html` for any path that is not a file (the app's own
 * routes), bound to 127.0.0.1 only. With port 0 the system picks a free port; like `apps/api`'s
 * `main.ts`, it prints one `{"msg":"listening","address":…,"port":…}` line once it is listening.
 *
 * Usage: node static-server.ts <directory> [port] [marker]. The marker is not read: it only
 * puts the run's name on the command line, so `down` can check a PID is still this run's own
 * process before stopping it.
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";

import { resolveRequestPath } from "./static-paths.ts";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

const root = path.resolve(process.argv[2] ?? ".");
const port = Number(process.argv[3] ?? "0");

async function fileFor(urlPath: string): Promise<string | undefined> {
  const candidate = resolveRequestPath(root, urlPath);
  if (candidate === undefined) {
    return undefined;
  }
  try {
    const info = await stat(candidate);
    return info.isFile() ? candidate : undefined;
  } catch {
    return undefined;
  }
}

const server = createServer((request, response) => {
  void (async () => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" }).end();
      return;
    }
    const urlPath = new URL(request.url ?? "/", "http://localhost").pathname;
    let file = await fileFor(urlPath);
    // A path with no file behind it is one of the app's own routes, unless it names a file type.
    if (!file && path.extname(urlPath) === "") {
      file = await fileFor("/index.html");
    }
    if (!file) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found\n");
      return;
    }
    response.writeHead(200, {
      "Content-Type": CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    createReadStream(file).pipe(response);
  })().catch(() => {
    if (!response.headersSent) {
      response.writeHead(500).end();
    } else {
      response.destroy();
    }
  });
});

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  if (address !== null && typeof address === "object") {
    process.stdout.write(`${JSON.stringify({ msg: "listening", address: address.address, port: address.port })}\n`);
  }
});

const shutdown = (): void => {
  server.close(() => process.exit(0));
  server.closeAllConnections();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
