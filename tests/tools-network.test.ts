// Ported line by line from BeingDesktop 0.8.26 test/desktop-network.test.cjs on 2026-09-16.
import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { Readable, PassThrough } from "node:stream";
import { portalRequestAdapter } from "../desktop/main/tools/network";
import type { NativeRequest, NativeRequestFactory, PortalRequestAdapter } from "../desktop/main/tools/network";

const ASSET = new URL("https://github.com/d5z/heart-portal/releases/download/v0.8.0/heart-portal-windows-x86_64.exe");
const REDIRECT = "https://release-assets.githubusercontent.com/fixture?signature=private-fixture";
const HEADERS = { "user-agent": "Being-Desktop-Portal-Installer", accept: "application/octet-stream" };

type FixtureNative = EventEmitter & NativeRequest & { headers: Record<string, string>; endCount: number; abortCount: number; followCount: number; followRedirect(): void };
function deferred<T = any>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function rejectsWith(promise: Promise<unknown>, name: string, message: string) {
  return promise.then(() => { throw new Error("expected a rejection"); }, (error: Error) => { expect(error.name).toBe(name); expect(error.message).toBe(message); });
}
function nativeRequest({ abortError = "none" }: { abortError?: string } = {}): FixtureNative {
  const request = new EventEmitter() as FixtureNative;
  Object.assign(request, { headers: {}, endCount: 0, abortCount: 0, followCount: 0 });
  request.setHeader = (name: string, value: string) => { request.headers[name.toLowerCase()] = value; };
  request.end = () => { request.endCount++; };
  request.abort = () => {
    request.abortCount++;
    request.emit("abort");
    const error = new Error("Redirect was cancelled https://private.test/?token=private-fixture-token");
    if (abortError === "sync") request.emit("error", error);
    if (abortError === "async") queueMicrotask(() => request.emit("error", error));
  };
  request.followRedirect = () => { request.followCount++; };
  return request;
}
function transport(options: { abortError?: string; constructorFailure?: boolean } = {}) {
  const requests: { init: any; request: FixtureNative }[] = [];
  const constructed = deferred<FixtureNative>();
  const factory: NativeRequestFactory = (init) => {
    if (options.constructorFailure) throw new Error("private-fixture-token from constructor");
    const request = nativeRequest(options);
    requests.push({ init, request });
    constructed.resolve(request);
    return request;
  };
  return { requests, constructed: constructed.promise, adapter: portalRequestAdapter(factory) };
}
function begin(adapter: PortalRequestAdapter, { url = ASSET, options = {} }: { url?: URL; options?: unknown } = {}) {
  const ready = deferred<any>();
  const errors: Error[] = [], responses: any[] = [];
  const request = adapter(url, options, (response) => { responses.push(response); ready.resolve(response); });
  request.on("error", (error: Error) => { errors.push(error); ready.reject(error); });
  return { request, errors, responses, response: ready.promise, start() { request.end(); } };
}
function incoming(value = "fixture", statusCode = 200, headers: Record<string, unknown> = {}) {
  const response = Readable.from([Buffer.from(value)]) as Readable & { statusCode?: number; headers?: Record<string, unknown> };
  response.statusCode = statusCode;
  response.headers = headers;
  return response;
}
async function readBody(body: AsyncIterable<unknown>) {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString("utf8");
}

describe("portal installer network adapter", () => {
  it("native request fixes GET, manual redirect, omitted credentials, no referrer and no session cookies", async () => {
    const t = transport(), h = begin(t.adapter);
    h.start();
    const native = await t.constructed;
    expect(t.requests.length).toBe(1);
    const { init } = t.requests[0];
    expect(init.url).toBe(ASSET.href);
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("manual");
    expect(init.credentials).toBe("omit");
    expect(init.useSessionCookies).toBe(false);
    expect(init.referrerPolicy).toBe("no-referrer");
    expect(native.headers).toEqual(HEADERS);
    const source = incoming("fixture", 200, { "content-length": "7" });
    native.emit("response", source);
    const body = await h.response;
    expect(body).toBe(source);
    expect(body.statusCode).toBe(200);
    expect(body.headers["content-length"]).toBe("7");
    expect(await readBody(body)).toBe("fixture");
  });

  it("caller methods and authentication headers cannot override fixed native download headers", async () => {
    const t = transport();
    const h = begin(t.adapter, { options: { method: "POST", headers: {
      Authorization: "Bearer private-fixture-token", Cookie: "private-fixture-cookie",
      "Proxy-Authorization": "private-fixture-proxy", Referer: "https://private.test/",
      "User-Agent": "caller-controlled", Accept: "text/html",
    } } });
    h.start();
    const native = await t.constructed;
    expect(native.headers).toEqual(HEADERS);
    expect(t.requests[0].init.method).toBe("GET");
    expect(JSON.stringify(t.requests[0].init)).not.toMatch(/private-fixture|caller-controlled/);
    native.emit("response", incoming());
    await readBody(await h.response);
  });

  it("native redirect statuses become empty Node responses for installer URL validation", async () => {
    for (const statusCode of [301, 302, 303, 307, 308]) {
      const t = transport(), h = begin(t.adapter);
      h.start();
      const native = await t.constructed;
      native.emit("redirect", statusCode, "GET", REDIRECT, { location: ["ignored-header-placeholder"] });
      const body = await h.response;
      expect(body.statusCode).toBe(statusCode);
      expect(body.headers.location).toBe(REDIRECT);
      expect(await readBody(body)).toBe("");
      expect(native.abortCount).toBe(1);
      expect(native.followCount).toBe(0);
      expect(t.requests.length).toBe(1);
    }
  });

  it("synchronous abort errors after redirect cannot reject the synthetic response", async () => {
    const t = transport({ abortError: "sync" }), h = begin(t.adapter);
    h.start();
    const native = await t.constructed;
    native.emit("redirect", 302, "GET", REDIRECT, {});
    expect(await readBody(await h.response)).toBe("");
    expect(h.errors).toEqual([]);
    expect(h.responses.length).toBe(1);
  });

  it("asynchronous abort errors after redirect are suppressed without exposing their URLs", async () => {
    const t = transport({ abortError: "async" }), h = begin(t.adapter);
    h.start();
    const native = await t.constructed;
    native.emit("redirect", 302, "GET", REDIRECT, {});
    expect(await readBody(await h.response)).toBe("");
    await Promise.resolve();
    expect(h.errors).toEqual([]);
    expect(h.responses.length).toBe(1);
  });

  it("a late error from the redirected request cannot poison the next asset request", async () => {
    const t = transport(), first = begin(t.adapter);
    first.start();
    const oldNative = await t.constructed;
    oldNative.emit("redirect", 302, "GET", REDIRECT, {});
    const redirect = await first.response;
    await readBody(redirect);
    const next = begin(t.adapter, { url: new URL(redirect.headers.location) });
    next.start();
    const newNative = t.requests[1].request;
    oldNative.emit("error", new Error("late cancellation private-fixture-token"));
    newNative.emit("response", incoming("verified-fixture-body"));
    expect(await readBody(await next.response)).toBe("verified-fixture-body");
    expect(first.errors).toEqual([]);
    expect(next.errors).toEqual([]);
    expect(t.requests.length).toBe(2);
    expect(oldNative.abortCount).toBe(1);
    expect(newNative.abortCount).toBe(0);
  });

  it("native errors before headers become a fixed request error", async () => {
    const t = transport(), h = begin(t.adapter);
    h.start();
    const native = await t.constructed;
    const failed = rejectsWith(h.response, "Error", "Portal download failed");
    native.emit("error", new Error("https://private.test/?token=private-fixture-token"));
    await failed;
    expect(h.responses.length).toBe(0);
    expect(h.errors[0].message).not.toMatch(/private-fixture|https/);
  });

  it("synchronous native constructor failure uses the same fixed request error", async () => {
    const t = transport({ constructorFailure: true }), h = begin(t.adapter);
    const failed = rejectsWith(h.response, "Error", "Portal download failed");
    expect(() => h.start()).not.toThrow();
    await failed;
    expect(h.responses.length).toBe(0);
  });

  it("repeated end calls construct and send exactly one native request", async () => {
    const t = transport(), h = begin(t.adapter);
    h.start();
    h.start();
    const native = await t.constructed;
    expect(t.requests.length).toBe(1);
    expect(native.endCount).toBe(1);
    native.emit("response", incoming());
    await readBody(await h.response);
  });

  it("native HTTP errors preserve status, headers, and readable response for installer handling", async () => {
    const t = transport(), h = begin(t.adapter);
    h.start();
    const native = await t.constructed;
    const source = incoming("fixture-error", 403, { "retry-after": "60" });
    native.emit("response", source);
    const body = await h.response;
    expect(body).toBe(source);
    expect(body.statusCode).toBe(403);
    expect(body.headers["retry-after"]).toBe("60");
    expect(await readBody(body)).toBe("fixture-error");
    expect(h.responses.length).toBe(1);
  });

  it("download stream errors remain observable after response headers were delivered", async () => {
    const t = transport(), h = begin(t.adapter);
    h.start();
    const native = await t.constructed;
    const source = new PassThrough() as PassThrough & { statusCode?: number; headers?: Record<string, unknown> };
    source.statusCode = 200;
    source.headers = {};
    native.emit("response", source);
    const body = await h.response;
    expect(body).toBe(source);
    const failed = expect(readBody(body)).rejects.toThrow(/Fixture data interrupted/);
    source.write(Buffer.from("partial-body"));
    source.destroy(new Error("Fixture data interrupted"));
    await failed;
  });

  it("redirect followed by a late native response cannot deliver two callbacks", async () => {
    const t = transport(), h = begin(t.adapter);
    h.start();
    const native = await t.constructed;
    native.emit("redirect", 302, "GET", REDIRECT, {});
    native.emit("response", incoming("late-body"));
    expect(await readBody(await h.response)).toBe("");
    expect(h.responses.length).toBe(1);
    expect(native.abortCount).toBe(1);
  });

  it("installer cancellation aborts native I/O and ignores late headers without leaking errors", async () => {
    const t = transport({ abortError: "sync" }), h = begin(t.adapter); h.start(); const native = await t.constructed;
    h.request.destroy(); native.emit("response", incoming("late"));
    expect(native.abortCount).toBe(1); expect(h.errors).toEqual([]); expect(h.responses.length).toBe(0);
  });
});
