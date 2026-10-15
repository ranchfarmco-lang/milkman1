/**
 * A real WebSocket echo server, in the host's own code.
 *
 * §6 requires WebSocket connections "where required", and §44 requires the host
 * to test its WebSocket support. Depending on somebody else's public echo
 * endpoint to do that is a bad test: when that service is down the host would
 * report a failure that says nothing about the host. So the host carries its own
 * echo endpoint and tests against that.
 *
 * The host runs on two runtimes, and they differ in one place that matters here:
 * Node's HTTP server hands an upgraded connection over as a plain socket and
 * expects the code to speak RFC 6455 itself, while Bun's server does the
 * handshake and the framing and exposes a `websocket` handler. Measured on this
 * machine, Bun's Node-compatible upgrade socket accepts a write and delivers
 * nothing — so this module uses each runtime's real API rather than one path
 * that only works on one of them.
 *
 * Both paths are genuine: Node's is a full RFC 6455 implementation (the SHA-1
 * accept key, masked client frames in all three length forms, unmasked replies,
 * ping/pong, close), and Bun's is the runtime's own WebSocket server.
 */

import { createServer, type Server, type IncomingMessage } from "node:http";
import { createHash } from "node:crypto";
import type { Socket } from "node:net";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const PATH = "/ws";

/* ------------------------------------------------------------ Bun runtime --- */

type BunWebSocket = { send: (data: string | Uint8Array) => void };
type BunServerLike = { port: number; stop: (closeActiveConnections?: boolean) => void };
type BunLike = {
  serve: (options: {
    port: number;
    hostname?: string;
    fetch: (request: Request, server: { upgrade: (request: Request) => boolean }) => Response | undefined;
    websocket: { message: (socket: BunWebSocket, message: string | Uint8Array) => void };
  }) => BunServerLike;
};

function bun(): BunLike | null {
  const candidate = (globalThis as { Bun?: unknown }).Bun;
  if (!candidate || typeof (candidate as BunLike).serve !== "function") return null;
  return candidate as BunLike;
}

/* ----------------------------------------------------------- Node runtime --- */

function acceptKey(key: string): string {
  return createHash("sha1").update(key + GUID).digest("base64");
}

/** One server-side (unmasked) frame. */
function frame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

/** One parsed frame. Returns null while more bytes are still needed. */
function parseFrame(buffer: Buffer): { opcode: number; payload: Buffer; rest: Buffer } | null {
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    length = Number(buffer.readBigUInt64BE(offset));
    offset += 8;
  }

  const maskKey = masked ? buffer.subarray(offset, offset + 4) : null;
  if (masked) offset += 4;
  if (buffer.length < offset + length) return null;

  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (maskKey) {
    for (let i = 0; i < payload.length; i += 1) payload[i] ^= maskKey[i % 4];
  }
  return { opcode, payload, rest: buffer.subarray(offset + length) };
}

function handleSocket(socket: Socket, request: IncomingMessage): void {
  const key = request.headers["sec-websocket-key"];
  if (typeof key !== "string") {
    socket.destroy();
    return;
  }
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${acceptKey(key)}`,
      "",
      "",
    ].join("\r\n"),
  );

  let pending = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    for (;;) {
      const parsed = parseFrame(pending);
      if (!parsed) break;
      pending = Buffer.from(parsed.rest);

      if (parsed.opcode === 0x8) {
        socket.write(frame(0x8, Buffer.alloc(0)));
        socket.end();
        return;
      }
      if (parsed.opcode === 0x9) {
        socket.write(frame(0xa, parsed.payload));
        continue;
      }
      if (parsed.opcode === 0x1 || parsed.opcode === 0x2) {
        socket.write(frame(parsed.opcode, parsed.payload));
      }
    }
  });
  socket.on("error", () => socket.destroy());
}

/* ----------------------------------------------------------------- the API --- */

export type EchoServer = { url: string; port: number; runtime: "bun" | "node"; close: () => Promise<void> };

/**
 * Start the echo server on a free loopback port. The caller owns its lifetime;
 * the host starts one for the duration of a self test and closes it again.
 */
export async function startEchoServer(): Promise<EchoServer> {
  const runtime = bun();

  if (runtime) {
    const server = runtime.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request, upgrade) {
        if (new URL(request.url).pathname === PATH && upgrade.upgrade(request)) return undefined;
        return new Response("This endpoint speaks WebSocket over /ws, not plain HTTP.", { status: 426 });
      },
      websocket: {
        message(socket, message) {
          socket.send(message);
        },
      },
    });
    return {
      url: `ws://127.0.0.1:${server.port}${PATH}`,
      port: server.port,
      runtime: "bun",
      close: async () => server.stop(true),
    };
  }

  const server: Server = createServer((_, response) => {
    response.writeHead(426, { "content-type": "text/plain" });
    response.end("This endpoint speaks WebSocket over /ws, not plain HTTP.");
  });
  server.on("upgrade", (request, socket) => {
    if ((request.url ?? "/").split("?")[0] !== PATH) {
      socket.destroy();
      return;
    }
    handleSocket(socket as Socket, request);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  return {
    url: `ws://127.0.0.1:${port}${PATH}`,
    port,
    runtime: "node",
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
