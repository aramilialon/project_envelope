/**
 * How the random walk (ADR 0013) talks to the API: one `request` call, whatever carries it. The
 * `inject` driver runs the request through Fastify in-process (the integration suite, CI); the
 * `fetch` driver sends it over a real HTTP connection to a running server (a smoke run, or a long
 * run against the real process). The walk never knows which one it has.
 */
import type { App } from "../../app.ts";

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface WalkResponse {
  readonly status: number;
  /** The parsed JSON body, or undefined for an empty one (a 204). */
  readonly body: unknown;
}

export interface WalkDriver {
  readonly name: "inject" | "fetch";
  request(method: HttpMethod, path: string, body: unknown, token: string): Promise<WalkResponse>;
}

function parseBody(text: string): unknown {
  if (text === "") {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function injectDriver(app: App): WalkDriver {
  return {
    name: "inject",
    async request(method, path, body, token) {
      const response = await app.fastify.inject({
        method,
        url: path,
        headers: { authorization: `Bearer ${token}` },
        ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
      });
      return { status: response.statusCode, body: parseBody(response.body) };
    },
  };
}

export function fetchDriver(baseUrl: string): WalkDriver {
  return {
    name: "fetch",
    async request(method, path, body, token) {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: parseBody(await response.text()) };
    },
  };
}
