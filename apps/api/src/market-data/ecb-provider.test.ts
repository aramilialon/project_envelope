import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

import { isValidationError } from "@envelope/core";

import {
  createEcbFileFetcher,
  createEcbProvider,
  ECB_HISTORY_FILE,
  ECB_RECENT_FILE,
  EcbFetchError,
  type EcbFile,
  ecbFileFor,
} from "./ecb-provider.ts";

const fixture = (name: string): Promise<string> => readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("ecbFileFor (#85)", () => {
  it("reads the full history when nothing is stored, or after a gap the 90-day file cannot close", () => {
    assert.equal(ecbFileFor(null, "2026-11-22"), ECB_HISTORY_FILE);
    assert.equal(ecbFileFor("2026-09-02", "2026-11-22"), ECB_HISTORY_FILE); // 81 days
    assert.equal(ecbFileFor("2026-09-03", "2026-11-22"), ECB_RECENT_FILE); // 80 days
    assert.equal(ecbFileFor("2026-11-20", "2026-11-22"), ECB_RECENT_FILE);
    // A stored day after "today" (a clock behind) is not a gap.
    assert.equal(ecbFileFor("2026-11-23", "2026-11-22"), ECB_RECENT_FILE);
  });
});

describe("createEcbProvider (#85)", () => {
  it("asks for the file the stored rates need and returns its rates, never fetching anything else", async () => {
    const asked: EcbFile[] = [];
    const provider = createEcbProvider({
      fetchFile: async (file) => {
        asked.push(file);
        return fixture(file === ECB_HISTORY_FILE ? "ecb-hist.xml" : "ecb-hist-90d.xml");
      },
      today: () => "2026-11-22",
    });
    assert.equal(provider.id, "ecb");
    assert.equal(provider.fetchPrices, undefined);
    const history = await provider.fetchFxRates!({ since: null }, AbortSignal.timeout(1000));
    assert.equal(history.length, 77);
    const recent = await provider.fetchFxRates!({ since: "2026-11-20" }, AbortSignal.timeout(1000));
    assert.equal(recent.length, 87);
    assert.deepEqual(asked, [ECB_HISTORY_FILE, ECB_RECENT_FILE]);
  });

  it("passes the job's signal on to the fetch", async () => {
    let received: AbortSignal | undefined;
    const provider = createEcbProvider({
      fetchFile: async (_file, signal) => {
        received = signal;
        return fixture("ecb-hist.xml");
      },
    });
    const signal = AbortSignal.timeout(1000);
    await provider.fetchFxRates!({ since: null }, signal);
    assert.equal(received, signal);
  });

  it("refuses a malformed file as a whole", async () => {
    const provider = createEcbProvider({ fetchFile: async () => (await fixture("ecb-hist.xml")).replace('rate="1.099"', 'rate="1,099"') });
    await assert.rejects(provider.fetchFxRates!({ since: null }, AbortSignal.timeout(1000)), (error) =>
      isValidationError(error, "invalid_rates_file"),
    );
  });
});

/**
 * The real fetcher, against a server of this test's own on 127.0.0.1: never the network. Each
 * path answers in one of the ways the fetcher must refuse.
 */
describe("createEcbFileFetcher (#85)", () => {
  let server: Server;
  let baseUrl: string;
  const requests: { url: string; method: string; headers: IncomingMessage["headers"] }[] = [];
  let body: string;
  // Each test picks how the server answers the next request.
  let answer: (request: IncomingMessage, response: ServerResponse) => void;

  before(async () => {
    body = await fixture("ecb-hist.xml");
    server = createServer((request, response) => {
      requests.push({ url: request.url ?? "", method: request.method ?? "", headers: request.headers });
      answer(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/stats/eurofxref/`;
  });

  after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const fetchFile = (maxBytes?: number) => createEcbFileFetcher({ baseUrl, ...(maxBytes === undefined ? {} : { maxBytes }) });

  async function assertFetchError(code: EcbFetchError["code"], maxBytes?: number): Promise<void> {
    await assert.rejects(fetchFile(maxBytes)(ECB_RECENT_FILE, AbortSignal.timeout(2000)), (error: unknown) => {
      assert.ok(error instanceof EcbFetchError, String(error));
      assert.equal(error.code, code);
      return true;
    });
  }

  it("GETs the named file in the configured directory, and nothing about the server or its users", async () => {
    requests.length = 0;
    answer = (_request, response) => response.writeHead(200, { "content-type": "text/xml" }).end(body);
    assert.equal(await fetchFile()(ECB_HISTORY_FILE, AbortSignal.timeout(2000)), body);
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.method, "GET");
    assert.equal(requests[0]?.url, "/stats/eurofxref/eurofxref-hist.xml");
    assert.equal(requests[0]?.headers.cookie, undefined);
    assert.equal(requests[0]?.headers.authorization, undefined);
  });

  it("accepts application/xml and a charset parameter", async () => {
    answer = (_request, response) => response.writeHead(200, { "content-type": "application/xml; charset=UTF-8" }).end(body);
    assert.equal(await fetchFile()(ECB_RECENT_FILE, AbortSignal.timeout(2000)), body);
  });

  it("refuses an answer that is not 2xx", async () => {
    answer = (_request, response) => response.writeHead(503, { "content-type": "text/xml" }).end(body);
    await assertFetchError("http_status");
  });

  it("follows no redirect, not even to the same host", async () => {
    requests.length = 0;
    answer = (request, response) => {
      if (request.url?.endsWith("moved.xml")) {
        response.writeHead(200, { "content-type": "text/xml" }).end(body);
      } else {
        response.writeHead(302, { location: `${baseUrl}moved.xml` }).end();
      }
    };
    await assert.rejects(fetchFile()(ECB_RECENT_FILE, AbortSignal.timeout(2000)), TypeError);
    assert.equal(requests.length, 1);
  });

  it("refuses a content type other than XML: an HTML error page, JSON, none", async () => {
    for (const type of ["text/html", "application/json", "text/plain", ""]) {
      answer = (_request, response) => response.writeHead(200, type ? { "content-type": type } : {}).end(body);
      await assertFetchError("content_type");
    }
  });

  it("refuses a body declared larger than the cap, before reading it", async () => {
    answer = (_request, response) => response.writeHead(200, { "content-type": "text/xml", "content-length": String(body.length) }).end(body);
    await assertFetchError("too_large", body.length - 1);
    assert.equal(await fetchFile(body.length)(ECB_RECENT_FILE, AbortSignal.timeout(2000)), body);
  });

  it("stops reading a body that grows past the cap without declaring its length", async () => {
    answer = (_request, response) => {
      response.writeHead(200, { "content-type": "text/xml" });
      // Chunked, no content-length: written in pieces, more than the cap allows.
      for (let i = 0; i < 8; i++) response.write(body);
      response.end();
    };
    await assertFetchError("too_large", body.length * 2);
  });

  it("refuses a body that is not UTF-8", async () => {
    answer = (_request, response) => response.writeHead(200, { "content-type": "text/xml" }).end(Buffer.from([0x3c, 0xff, 0xfe, 0x3e]));
    await assertFetchError("not_utf8");
  });

  it("gives up when the job's time limit passes, whether the answer or its body never comes", async () => {
    answer = () => {
      // never answers
    };
    await assert.rejects(fetchFile()(ECB_RECENT_FILE, AbortSignal.timeout(100)), (error: unknown) => {
      assert.equal((error as Error).name, "TimeoutError");
      return true;
    });
    answer = (_request, response) => {
      response.writeHead(200, { "content-type": "text/xml" });
      response.write(body.slice(0, 100)); // and never the rest
    };
    await assert.rejects(fetchFile()(ECB_RECENT_FILE, AbortSignal.timeout(100)), (error: unknown) => {
      assert.equal((error as Error).name, "TimeoutError");
      return true;
    });
  });
});
