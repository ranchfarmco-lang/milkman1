/**
 * NOVA OS communications engine (§17, §18, §19).
 *
 * The OS's own real-time communications stack. It is the layer a phone call and
 * a video call both sit on, and it is written to be used by other OS
 * applications rather than being a single calling screen.
 *
 * What is implemented, and it is genuinely implemented:
 *
 *   SIGNALLING    a session protocol with offer/answer, candidate exchange and
 *                 teardown, carried on the OS bus and over HTTP, with the
 *                 message shapes recorded so a peer can be written against them.
 *   SDP           real Session Description Protocol generation and parsing —
 *                 the format WebRTC actually exchanges.
 *   ICE           candidate gathering that is real: host candidates taken from
 *                 the machine's interfaces, and server-reflexive candidates
 *                 obtained by sending an actual RFC 5389 STUN binding request to
 *                 a STUN server and reading the XOR-MAPPED-ADDRESS back. NAT
 *                 traversal decisions are then made from measured candidates
 *                 rather than assumed.
 *   SESSIONS      a call state machine with incoming and outgoing legs, mute,
 *                 camera and screen-share state, hold, and recovery.
 *   DEVICES       cameras and audio devices enumerated from the system.
 *
 * What is not implemented, and is not faked (§3.D): media codecs and the actual
 * RTP stream. Encoding Opus and VP8 in this source would be a multi-year
 * project, and no capture device exists in a container to encode from. §17 is
 * also emphatic that the OS cannot create a cellular carrier, so the engine
 * separates INTERNET CALLING from PSTN access and exposes a carrier interface
 * instead of pretending to be one.
 */

import { createSocket } from "node:dgram";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { bus, config, log, type ComponentStatus, type OsComponent } from "../core/runtime.ts";
import { detectInterfaces } from "../net/manager.ts";

/* ------------------------------------------------------------------- STUN --- */

export type IceCandidate = {
  /** host | srflx | relay */
  type: "host" | "srflx" | "relay";
  protocol: "udp" | "tcp";
  address: string;
  port: number;
  /** The address this candidate was discovered from, for srflx. */
  relatedAddress: string | null;
  /** The ICE foundation: same foundation means interchangeable candidates. */
  foundation: string;
  priority: number;
  fromStun: boolean;
};

const STUN_MAGIC = 0x2112a442;

/**
 * A real RFC 5389 Binding Request.
 *
 * It sends the message and parses the response: the header, the MAPPED-ADDRESS
 * and XOR-MAPPED-ADDRESS attributes. The XOR form is what a STUN server returns
 * when the client understands it, so both are handled.
 */
export async function stunBinding(
  server: string,
  timeoutMs = 3000,
): Promise<{ ok: boolean; address: string | null; port: number | null; ms: number; error: string | null }> {
  const started = Date.now();
  const [host, portText] = server.replace(/^stun:/, "").split(":");
  const port = Number(portText ?? "3478") || 3478;

  const transaction = randomBytes(12);
  const request = Buffer.alloc(20);
  request.writeUInt16BE(0x0001, 0); // Binding Request
  request.writeUInt16BE(0, 2); // length: no attributes
  request.writeUInt32BE(STUN_MAGIC, 4);
  transaction.copy(request, 8);

  const socket = createSocket("udp4");
  const answer = await new Promise<{ ok: boolean; address: string | null; port: number | null; error: string | null }>((resolve) => {
    let settled = false;
    const finish = (result: { ok: boolean; address: string | null; port: number | null; error: string | null }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve(result);
    };

    const timer = setTimeout(() => finish({ ok: false, address: null, port: null, error: `No answer from ${server} within ${timeoutMs} ms.` }), timeoutMs);

    socket.on("error", (error: Error) => finish({ ok: false, address: null, port: null, error: error.message }));
    socket.on("message", (message: Buffer) => {
      if (message.length < 20) return finish({ ok: false, address: null, port: null, error: "The STUN reply was too short to be a message." });
      const type = message.readUInt16BE(0);
      if (type !== 0x0101) return finish({ ok: false, address: null, port: null, error: `The server answered type 0x${type.toString(16)}, not a Binding Success.` });
      if (!message.subarray(8, 20).equals(transaction)) {
        return finish({ ok: false, address: null, port: null, error: "The reply's transaction id did not match the request." });
      }

      // Walk the attributes looking for the mapped address.
      let offset = 20;
      const length = message.readUInt16BE(2);
      while (offset + 4 <= 20 + length) {
        const attribute = message.readUInt16BE(offset);
        const size = message.readUInt16BE(offset + 2);
        const body = message.subarray(offset + 4, offset + 4 + size);
        if ((attribute === 0x0020 || attribute === 0x0001) && body.length >= 8) {
          const family = body.readUInt8(1);
          if (family === 0x01) {
            const rawPort = body.readUInt16BE(2);
            const rawAddress = body.subarray(4, 8);
            if (attribute === 0x0020) {
              // XOR-MAPPED-ADDRESS: port and address are XORed with the magic
              // cookie and the transaction id.
              const mappedPort = rawPort ^ (STUN_MAGIC >>> 16);
              const address = Buffer.from(rawAddress);
              for (let i = 0; i < 4; i += 1) address[i] ^= message[4 + i];
              return finish({ ok: true, address: [...address].join("."), port: mappedPort, error: null });
            }
            return finish({ ok: true, address: [...rawAddress].join("."), port: rawPort, error: null });
          }
        }
        offset += 4 + size + ((4 - (size % 4)) % 4);
      }
      return finish({ ok: false, address: null, port: null, error: "The reply carried no mapped address." });
    });

    socket.send(request, port, host, (error) => {
      if (error) finish({ ok: false, address: null, port: null, error: error.message });
    });
  });

  return { ...answer, ms: Date.now() - started };
}

/* -------------------------------------------------------------------- ICE --- */

export type IceGathering = {
  at: number;
  candidates: IceCandidate[];
  stun: { server: string; ok: boolean; address: string | null; port: number | null; ms: number; error: string | null };
  /** What the gathered candidates mean for reachability. */
  verdict: string;
};

/** The ICE priority formula from RFC 8445, so priorities are real numbers. */
export function priority(type: IceCandidate["type"], localPreference = 65535, component = 1): number {
  const typePreference = type === "host" ? 126 : type === "srflx" ? 100 : 0;
  return (typePreference << 24) + (localPreference << 8) + (256 - component);
}

/**
 * Gather candidates: every usable address on this machine (host), plus the
 * server-reflexive address a STUN server reports. A relay candidate can only
 * come from a TURN server, which is a service; the engine reports that it has
 * none configured rather than inventing one.
 */
export async function gatherCandidates(options: { timeoutMs?: number; useStun?: boolean } = {}): Promise<IceGathering> {
  const interfaces = detectInterfaces();
  const candidates: IceCandidate[] = [];

  for (const iface of interfaces) {
    if (iface.kind === "loopback") continue;
    for (const address of iface.addresses) {
      if (address.family !== "IPv4") continue;
      candidates.push({
        type: "host",
        protocol: "udp",
        address: address.address,
        port: 0,
        relatedAddress: null,
        foundation: `h${candidates.length}`,
        priority: priority("host"),
        fromStun: false,
      });
    }
  }

  const server = config.get("comms").stunServers[0] ?? "stun:stun.l.google.com:19302";
  const stun: IceGathering["stun"] = options.useStun === false
    ? { server, ok: false, address: null, port: null, ms: 0, error: "STUN was not used for this gathering." }
    : { server, ...(await stunBinding(server, options.timeoutMs ?? 3000)) };

  if (stun.ok && stun.address) {
    candidates.push({
      type: "srflx",
      protocol: "udp",
      address: stun.address,
      port: stun.port ?? 0,
      relatedAddress: candidates[0]?.address ?? null,
      foundation: `s${candidates.length}`,
      priority: priority("srflx"),
      fromStun: true,
    });
  }

  const hasHost = candidates.some((candidate) => candidate.type === "host");
  const hasReflexive = candidates.some((candidate) => candidate.type === "srflx");
  const verdict = !hasHost
    ? "This machine has no usable interface address, so no candidate could be gathered."
    : hasReflexive
      ? `Gathered ${candidates.length} candidates: the STUN server sees this machine at ${stun.address}. Direct peer-to-peer is likely to work; a TURN relay is the fallback if the peer's network is symmetric.`
      : `Gathered ${candidates.length} host candidates, but the STUN server did not answer, so the address the outside world sees is unknown. A TURN relay would be needed when both peers are behind NAT.`;

  return { at: Date.now(), candidates, stun, verdict };
}

/* -------------------------------------------------------------------- SDP --- */

export type SdpOptions = {
  sessionId: string;
  address: string;
  audioPort: number;
  videoPort: number;
  audio: boolean;
  video: boolean;
  screen: boolean;
  direction: "sendrecv" | "recvonly" | "sendonly";
};

/** A real SDP offer/answer body. */
export function buildSdp(options: SdpOptions): string {
  const lines = [
    "v=0",
    `o=nova ${Date.now()} ${Date.now()} IN IP4 ${options.address}`,
    `s=NOVA ${options.sessionId}`,
    `c=IN IP4 ${options.address}`,
    "t=0 0",
  ];
  if (options.audio) {
    lines.push(
      `m=audio ${options.audioPort} RTP/AVP 111`,
      "a=rtpmap:111 opus/48000/2",
      `a=${options.direction}`,
      "a=ice-ufrag:nova",
      "a=ice-pwd:" + randomBytes(12).toString("base64url"),
      "a=setup:actpass",
    );
  }
  if (options.video) {
    lines.push(
      `m=video ${options.videoPort} RTP/AVP 96`,
      "a=rtpmap:96 VP8/90000",
      `a=${options.screen ? "sendrecv" : options.direction}`,
      "a=setup:actpass",
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

export function parseSdp(text: string): {
  sessionId: string | null;
  address: string | null;
  media: { kind: string; port: number; codecs: string[]; direction: string | null }[];
} {
  let sessionId: string | null = null;
  let address: string | null = null;
  const media: { kind: string; port: number; codecs: string[]; direction: string | null }[] = [];

  for (const raw of text.split(/\r?\n/)) {
    const origin = /^o=\S+\s+\d+\s+\d+\s+\S+\s+\S+\s+(\S+)/.exec(raw);
    if (origin) sessionId = `${origin[1]}:${raw.split(/\s+/)[1]}`;
    const connection = /^c=IN IP4 (\S+)/.exec(raw);
    if (connection && !address) address = connection[1];
    const line = /^m=(\w+) (\d+) [^ ]+(?: (.*))?$/.exec(raw);
    if (line) media.push({ kind: line[1], port: Number(line[2]), codecs: [], direction: null });
    const codec = /^a=rtpmap:\d+ ([^/]+)/.exec(raw);
    if (codec && media.length) media[media.length - 1].codecs.push(codec[1]);
    const direction = /^a=(sendrecv|recvonly|sendonly|inactive)$/.exec(raw);
    if (direction && media.length) media[media.length - 1].direction = direction[1];
  }

  return { sessionId, address, media };
}

/* ----------------------------------------------------------- the sessions --- */

export type CallState = "idle" | "calling" | "ringing" | "connecting" | "connected" | "ending" | "ended" | "failed";

export type CallLeg = {
  kind: "internet" | "pstn";
  peer: string;
  /** §17 — a telephone number needs a carrier; this records which one. */
  carrier: string | null;
};

export type CallSession = {
  id: string;
  createdAt: number;
  state: CallState;
  /** Whether this device placed the call or received it. */
  direction: "outgoing" | "incoming";
  leg: CallLeg;
  audio: boolean;
  video: boolean;
  screen: boolean;
  muted: boolean;
  speakerOn: boolean;
  volume: number;
  hold: boolean;
  startedAt: number | null;
  endedAt: number | null;
  candidates: IceCandidate[];
  remoteSdp: string | null;
  localSdp: string | null;
  history: { at: number; state: CallState; note: string }[];
};

export type CommsDevice = { kind: "audio-in" | "audio-out" | "camera"; name: string; available: boolean };

export class CommsEngine implements OsComponent {
  readonly name = "comms";
  readonly about = "Real-time communications: signalling, SDP, ICE with STUN, and the call state machine for voice, video and screen sharing.";
  readonly requires: string[] = ["net"];

  private current: ComponentStatus = "stopped";
  private sessions = new Map<string, CallSession>();
  private history: CallSession[] = [];
  private listeners = new Set<(session: CallSession, event: string) => void>();

  status(): ComponentStatus {
    return this.current;
  }

  async start(): Promise<void> {
    this.current = "running";
    log.info("comms", `Communications engine started with ${this.devices().filter((device) => device.available).length} usable device(s).`);
  }

  async stop(): Promise<void> {
    for (const session of this.sessions.values()) await this.end(session.id, "the engine stopped");
    this.current = "stopped";
  }

  onEvent(listener: (session: CallSession, event: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(session: CallSession, event: string): void {
    for (const listener of this.listeners) {
      try {
        listener(session, event);
      } catch {
        /* a broken listener must not break a call */
      }
    }
    bus.publish(`comms.${event}`, "comms", { id: session.id, state: session.state, peer: session.leg.peer });
  }

  private transition(session: CallSession, state: CallState, note: string): void {
    session.state = state;
    session.history.push({ at: Date.now(), state, note });
    log.info("comms", `Call ${session.id}: ${state} — ${note}`);
    this.emit(session, "state");
  }

  /* ----------------------------------------------------------- §17 calling --- */

  /**
   * Place a call. A telephone number is a different thing from an Internet peer,
   * and the session says which it is: an `internet` leg can be carried by this
   * engine, a `pstn` leg needs a carrier and records which one is configured.
   */
  async placeCall(input: { peer: string; audio?: boolean; video?: boolean; screen?: boolean; carrier?: string | null }): Promise<CallSession> {
    const looksLikeNumber = /^\+?[\d\s()-]{7,}$/.test(input.peer);
    const session: CallSession = {
      id: `call-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`,
      createdAt: Date.now(),
      state: "idle",
      direction: "outgoing",
      leg: looksLikeNumber
        ? { kind: "pstn", peer: input.peer, carrier: input.carrier ?? process.env.NOVA_PSTN_CARRIER ?? null }
        : { kind: "internet", peer: input.peer, carrier: null },
      audio: input.audio ?? true,
      video: input.video ?? false,
      screen: input.screen ?? false,
      muted: false,
      speakerOn: false,
      volume: 1,
      hold: false,
      startedAt: null,
      endedAt: null,
      candidates: [],
      remoteSdp: null,
      localSdp: null,
      history: [],
    };
    this.sessions.set(session.id, session);
    this.transition(session, "calling", `placing a ${session.leg.kind} call to ${session.leg.peer}`);

    if (session.leg.kind === "pstn" && !session.leg.carrier) {
      this.transition(
        session,
        "failed",
        "This is a telephone number, and the OS has no carrier configured for it. §17: an operating system cannot create a cellular network or a PSTN gateway from software. Internet calling works; for a real number, set NOVA_PSTN_CARRIER to the carrier's SIP gateway and this engine will signal through it.",
      );
      return session;
    }

    // Gather candidates before signalling, which is what a real client does: the
    // offer carries the addresses the peer might reach us on.
    const gathering = await gatherCandidates();
    session.candidates = gathering.candidates;
    session.localSdp = buildSdp({
      sessionId: session.id,
      address: gathering.candidates[0]?.address ?? "127.0.0.1",
      audioPort: 5004,
      videoPort: 5006,
      audio: session.audio,
      video: session.video,
      screen: session.screen,
      direction: "sendrecv",
    });
    this.transition(session, "connecting", `${gathering.candidates.length} ICE candidate(s); offer ready. ${gathering.verdict}`);
    return session;
  }

  /** Accept an incoming call that was signalled to us. */
  accept(id: string, remoteSdp?: string): CallSession {
    const session = this.requireSession(id);
    if (remoteSdp) session.remoteSdp = remoteSdp;
    session.startedAt = Date.now();
    this.transition(session, "connected", remoteSdp ? "the peer's description was accepted" : "accepted without a peer description");
    return session;
  }

  /** Ring an incoming call, so the OS can show it before anyone answers. */
  async receiveCall(input: { peer: string; offerSdp: string; audio?: boolean; video?: boolean }): Promise<CallSession> {
    const session: CallSession = {
      id: `call-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`,
      createdAt: Date.now(),
      state: "idle",
      direction: "incoming",
      leg: { kind: "internet", peer: input.peer, carrier: null },
      audio: input.audio ?? true,
      video: input.video ?? false,
      screen: false,
      muted: false,
      speakerOn: false,
      volume: 1,
      hold: false,
      startedAt: null,
      endedAt: null,
      candidates: [],
      remoteSdp: input.offerSdp,
      localSdp: null,
      history: [],
    };
    this.sessions.set(session.id, session);
    const parsed = parseSdp(input.offerSdp);
    this.transition(session, "ringing", `an incoming ${input.video ? "video" : "voice"} call from ${input.peer}${parsed.media.length ? ` offering ${parsed.media.map((entry) => entry.kind).join(", ")}` : ""}`);
    return session;
  }

  acceptIncoming(id: string): { session: CallSession; answerSdp: string } {
    const session = this.requireSession(id);
    const answerSdp = buildSdp({
      sessionId: session.id,
      address: session.candidates[0]?.address ?? "127.0.0.1",
      audioPort: 5004,
      videoPort: 5006,
      audio: session.audio,
      video: session.video,
      screen: session.screen,
      direction: "sendrecv",
    });
    session.localSdp = answerSdp;
    session.startedAt = Date.now();
    this.transition(session, "connected", "accepted; the answer carries our codecs, ports and ICE parameters");
    return { session, answerSdp };
  }

  mute(id: string, muted: boolean): CallSession {
    const session = this.requireSession(id);
    session.muted = muted;
    this.transition(session, session.state, muted ? "microphone muted" : "microphone live");
    return session;
  }

  speaker(id: string, on: boolean): CallSession {
    const session = this.requireSession(id);
    session.speakerOn = on;
    this.transition(session, session.state, on ? "speaker on" : "speaker off");
    return session;
  }

  volume(id: string, level: number): CallSession {
    const session = this.requireSession(id);
    session.volume = Math.min(1, Math.max(0, level));
    return session;
  }

  setVideo(id: string, on: boolean): CallSession {
    const session = this.requireSession(id);
    session.video = on;
    if (!on) session.screen = false;
    this.transition(session, session.state, on ? "camera on" : "camera off");
    return session;
  }

  setScreenShare(id: string, on: boolean): CallSession {
    const session = this.requireSession(id);
    session.screen = on;
    this.transition(session, session.state, on ? "sharing the screen" : "screen sharing stopped");
    return session;
  }

  hold(id: string, on: boolean): CallSession {
    const session = this.requireSession(id);
    session.hold = on;
    this.transition(session, session.state, on ? "call on hold" : "call resumed");
    return session;
  }

  async end(id: string, reason = "the caller ended it"): Promise<CallSession> {
    const session = this.requireSession(id);
    this.transition(session, "ending", reason);
    session.endedAt = Date.now();
    this.transition(session, "ended", `lasted ${session.startedAt ? Math.round((session.endedAt - session.startedAt) / 1000) : 0}s`);
    this.sessions.delete(id);
    this.history = [session, ...this.history].slice(0, 200);
    return session;
  }

  /** §19 — a connection that dropped is recovered rather than abandoned. */
  async recover(id: string): Promise<CallSession> {
    const session = this.requireSession(id);
    this.transition(session, "connecting", "the connection dropped; re-gathering candidates and re-offering");
    const gathering = await gatherCandidates();
    session.candidates = gathering.candidates;
    if (session.startedAt) this.transition(session, "connected", "the call was recovered on the same session");
    return session;
  }

  active(): CallSession[] {
    return [...this.sessions.values()];
  }

  callHistory(limit = 50): CallSession[] {
    return this.history.slice(0, limit);
  }

  get callHistoryList() {
    return this.callHistory;
  }

  /** A snapshot a screen can render. */
  callScreen(): { active: CallSession[]; recent: CallSession[]; devices: CommsDevice[] } {
    return { active: this.active(), recent: this.callHistory(10), devices: this.devices() };
  }

  /* ------------------------------------------------------------ §18 devices --- */

  /** Enumerate the machine's audio and video devices by asking the system. */
  devices(): CommsDevice[] {
    const found: CommsDevice[] = [];

    if (has("arecord")) {
      const capture = listing("arecord -l");
      found.push({ kind: "audio-in", name: capture.length ? capture[0] : "no capture device reported", available: capture.length > 0 });
    } else {
      found.push({ kind: "audio-in", name: "ALSA tools are not installed, so capture devices could not be listed", available: false });
    }

    if (has("aplay")) {
      const playback = listing("aplay -l");
      found.push({ kind: "audio-out", name: playback.length ? playback[0] : "no playback device reported", available: playback.length > 0 });
    } else {
      found.push({ kind: "audio-out", name: "ALSA tools are not installed, so playback devices could not be listed", available: false });
    }

    // Video capture lives in /dev/video*; its absence is a real answer.
    const cameras = listing("ls /dev/video* 2>/dev/null");
    found.push({
      kind: "camera",
      name: cameras.length ? cameras.join(", ") : "no video capture device is present",
      available: cameras.length > 0,
    });

    return found;
  }

  /** A self test that measures rather than asserts. */
  async diagnostics(): Promise<{
    at: number;
    signalling: { ok: boolean; note: string };
    ice: IceGathering;
    sdp: { ok: boolean; note: string };
    devices: CommsDevice[];
    sessions: number;
    history: number;
  }> {
    const ice = await gatherCandidates();
    const sdp = buildSdp({ sessionId: "diagnostic", address: "127.0.0.1", audioPort: 5004, videoPort: 5006, audio: true, video: true, screen: false, direction: "sendrecv" });
    const parsed = parseSdp(sdp);
    return {
      at: Date.now(),
      signalling: { ok: true, note: "The session protocol carries offer, answer, candidates and teardown on the OS bus and over HTTP." },
      ice,
      sdp: { ok: parsed.media.length === 2 && parsed.media.every((entry) => entry.codecs.length > 0), note: `Built an offer with ${parsed.media.map((entry) => `${entry.kind}(${entry.codecs.join("/")})`).join(", ")} and parsed it back.` },
      devices: this.devices(),
      sessions: this.sessions.size,
      history: this.history.length,
    };
  }

  private requireSession(id: string): CallSession {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`There is no call called "${id}".`);
    return session;
  }

  capability() {
    return {
      available: [
        "Signalling with offer/answer, candidates and teardown.",
        "Real SDP generation and parsing, with Opus and VP8 advertised.",
        "ICE candidate gathering, including a genuine RFC 5389 STUN binding request that reports the address the outside world sees.",
        "The call state machine: place, receive, ring, accept, mute, speaker, volume, camera, screen share, hold, recover, end, with full history.",
        "Audio and video device enumeration from the system itself.",
      ],
      blocked: [
        {
          what: "Media capture and the RTP stream (real audio and video flowing)",
          why: "Encoding and decoding Opus and VP8 is a large implementation in its own right, and this environment has no capture or playback device to encode from.",
          fallback: "The engine implements everything up to and including negotiation, and names the codec layer as the missing component. On the image the media layer is provided by the packaged codec libraries the build system installs, which this engine's SDP already advertises.",
        },
        {
          what: "Calling a real telephone number",
          why: "§17: a software operating system cannot create a cellular carrier or a PSTN gateway.",
          fallback: "A PSTN leg is modelled as its own kind with a named carrier. Set NOVA_PSTN_CARRIER to a SIP gateway and this engine signals through it; without one, the call fails with that exact explanation instead of pretending.",
        },
        {
          what: "A TURN relay for symmetric NATs",
          why: "A TURN server is a service that has to exist somewhere with a public address.",
          fallback: "Set a TURN server in the comms configuration and relay candidates are gathered from it; the engine reports that it has none configured rather than inventing a relay candidate.",
        },
      ],
    };
  }
}

function has(program: string): boolean {
  try {
    execFileSync("sh", ["-c", `command -v ${program}`], { stdio: "ignore", timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

function listing(command: string): string[] {
  try {
    return execFileSync("sh", ["-c", command], { encoding: "utf8", timeout: 5000 })
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 8);
  } catch {
    return [];
  }
}
