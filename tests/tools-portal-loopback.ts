// Ported line by line from BeingDesktop 0.8.26 test/integration/portal-loopback.cjs
// on 2026-09-16 — only `frame`, `LoopbackRelay` and `until`. The file's
// `connectionsFor` helper and its `run()` entry point drive PortalService
// (src/services.cjs) and belong to the Portal installer unit, not here.
// This is a fixture, not a suite: vitest only collects `tests/**/*.test.ts`.
// It speaks the `/_relay` reverse-MCP contract from the desktop's peer side —
// see docs/interfaces.md §6「/_relay 反向 MCP 协议」.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import type { Socket } from "node:net";
import { EventEmitter, once } from "node:events";

export function frame(opcode: number, value: Buffer | string): Buffer {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(value);
  assert.ok(body.length < 65536);
  const header = Buffer.alloc(body.length < 126 ? 2 : 4);
  header[0] = 0x80 | opcode;
  header[1] = body.length < 126 ? body.length : 126;
  if (body.length >= 126) header.writeUInt16BE(body.length, 2);
  return Buffer.concat([header, body]);
}

export interface LoopbackRelayOptions { beingId?: string; portalName?: string }

export class LoopbackRelay extends EventEmitter {
  token: string;
  beingId: string;
  portalName: string;
  sockets: Set<Socket>;
  accepted: number;
  rejected: number;
  metadataReplies: number;
  methodsSent: string[];
  toolNames: string[];
  server: http.Server;
  port!: number;
  runtimeVersion?: string;

  constructor(token: string, { beingId = "desktop-integration", portalName = "desktop-integration" }: LoopbackRelayOptions = {}) {
    super();
    this.token = token;
    this.beingId = beingId;
    this.portalName = portalName;
    this.sockets = new Set();
    this.accepted = 0;
    this.rejected = 0;
    this.metadataReplies = 0;
    this.methodsSent = [];
    this.toolNames = [];
    this.server = http.createServer((_request, response) => { response.writeHead(404); response.end(); });
    this.server.on("upgrade", (request, socket, head) => this.upgrade(request, socket as Socket, head));
  }

  async listen(port = 0): Promise<void> {
    this.server.listen(port, "127.0.0.1");
    await once(this.server, "listening");
    this.port = (this.server.address() as { port: number }).port;
  }

  async pause(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    if (this.server.listening) await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  upgrade(request: http.IncomingMessage, socket: Socket, head: Buffer): void {
    if (request.url !== "/_relay" || socket.remoteAddress !== "127.0.0.1" || !request.headers["sec-websocket-key"]) { socket.destroy(); return; }
    const accept = crypto.createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.setNoDelay(true);
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", () => {});
    let buffer = Buffer.alloc(0);
    let authenticated = false;
    const sendJson = (value: unknown) => socket.write(frame(1, JSON.stringify(value)));
    const sendRequest = (id: number, method: string, params: unknown = {}) => {
      assert.ok(["initialize", "tools/list"].includes(method));
      this.methodsSent.push(method);
      sendJson({ jsonrpc: "2.0", id, method, params });
    };
    const consume = (data: Buffer): void => {
      buffer = Buffer.concat([buffer, data]);
      if (buffer.length > 1024 * 1024) { socket.destroy(); return; }
      while (buffer.length >= 2) {
        const opcode = buffer[0]! & 15;
        if (!(buffer[0]! & 128) || !(buffer[1]! & 128)) { socket.destroy(); return; }
        let size = buffer[1]! & 127;
        let offset = 2;
        if (size === 126) {
          if (buffer.length < 4) return;
          size = buffer.readUInt16BE(2);
          offset = 4;
        } else if (size === 127) { socket.destroy(); return; }
        if (buffer.length < offset + 4 + size) return;
        const mask = buffer.subarray(offset, offset + 4);
        const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + size));
        for (let index = 0; index < size; index++) payload[index] ^= mask[index % 4]!;
        buffer = buffer.subarray(offset + 4 + size);
        if (opcode === 8) { socket.end(frame(8, Buffer.alloc(0))); return; }
        if (opcode === 9) { socket.write(frame(10, payload)); continue; }
        if (opcode !== 1) continue;
        let message: any;
        try { message = JSON.parse(payload.toString("utf8")); } catch { socket.destroy(); return; }
        if (!authenticated) {
          if (message.being_id !== this.beingId || message.loom_token !== this.token || message.portal_name !== this.portalName) {
            this.rejected++;
            sendJson({ ok: false });
            this.emit("change");
            continue;
          }
          authenticated = true;
          this.accepted++;
          sendJson({ ok: true, relay_keepalive: "text-v1" });
          sendRequest(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "desktop-loopback-fixture", version: "1.0.0" } });
          this.emit("change");
        } else if (message.type === "keepalive") {
          sendJson({ type: "keepalive_ack" });
        } else if (message.id === 1 && message.result) {
          this.runtimeVersion = message.result.serverInfo?.version;
          sendRequest(2, "tools/list");
        } else if (message.id === 2 && Array.isArray(message.result?.tools)) {
          this.toolNames = message.result.tools.map((tool: { name: string }) => tool.name);
          this.metadataReplies++;
          this.emit("change");
        }
        if (authenticated && Object.hasOwn(message, "id") && Object.hasOwn(message, "result")) this.emit("rpc_response", message);
      }
    };
    socket.on("data", consume);
    if (head.length) consume(head);
  }
}

export function until(emitter: EventEmitter, predicate: () => boolean, label: string, timeout = 25000): Promise<void> {
  if (predicate()) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const finish = () => { clearTimeout(timer); emitter.removeListener("change", check); };
    const check = () => { if (predicate()) { finish(); resolve(); } };
    const timer = setTimeout(() => { finish(); reject(new Error(`Timed out: ${label}`)); }, timeout);
    emitter.on("change", check);
  });
}
