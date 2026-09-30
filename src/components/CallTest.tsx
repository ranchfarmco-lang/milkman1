import { Button } from "@/components/ui/button";
import { api } from "@/convex/_generated/api";
import { cn } from "@/lib/utils";
import { useAction } from "convex/react";
import { ConnectionState, Room, RoomEvent } from "livekit-client";
import {
  ArrowLeftRight,
  Camera,
  Check,
  Copy,
  Loader2,
  Mic,
  PhoneCall,
  RefreshCw,
  Server,
  ShieldCheck,
  TriangleAlert,
  Video,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";

/**
 * The call test, drawn inside the messenger.
 *
 * It answers the only question that matters before anyone trusts a call: *does
 * the media actually arrive?* It checks the device, then the server, then — the
 * real test — whether a second device shows up.
 *
 * 1. **This device** — camera and microphone open, with a live level, so a
 *    blocked permission is told apart from a broken call.
 * 2. **The media server** — joins one fixed test room. Two devices that open
 *    this test land in the same room and see and hear each other. That is the
 *    cross-location test: each device connects *out* to the server, so it works
 *    from behind two different home routers instead of needing a path between
 *    them.
 * 3. **The direct path** — two real WebRTC connections, head to head, which
 *    prove the browser's own media pipeline works even with no server set up.
 *
 * Nothing here goes through the call tables: it talks to the relay directly, so
 * it still tells the truth when the rest of the calling code is misbehaving.
 * It lives on the messenger page itself — open it from the Test button in the
 * chat header.
 */
export function CallTest({ className }: { className?: string }) {
  const probe = useAction(api.livekit.probe);

  const [media, setMedia] = useState<MediaStream | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [mediaBusy, setMediaBusy] = useState(false);

  const [relayHost, setRelayHost] = useState<string | null>(null);
  const [relayRoom, setRelayRoom] = useState<string | null>(null);
  const [relayConfigured, setRelayConfigured] = useState<boolean | null>(null);
  const [relayState, setRelayState] = useState<ConnectionState | "idle">(
    ConnectionState.Disconnected,
  );
  const [relayBusy, setRelayBusy] = useState(false);
  const [relayError, setRelayError] = useState<string | null>(null);
  const [peers, setPeers] = useState<Record<string, string>>({});
  const [remoteStreams, setRemoteStreams] = useState<
    Record<string, MediaStream>
  >({});

  const [loopback, setLoopback] = useState<{
    toA: MediaStream;
    toB: MediaStream;
  } | null>(null);
  const [loopbackBusy, setLoopbackBusy] = useState(false);
  const [loopbackError, setLoopbackError] = useState<string | null>(null);

  const [copied, setCopied] = useState(false);

  const roomRef = useRef<Room | null>(null);
  const trackSets = useRef(new Map<string, Set<MediaStreamTrack>>());
  const loopbackRef = useRef<{ a: RTCPeerConnection; b: RTCPeerConnection } | null>(
    null,
  );

  const level = useMicLevel(media, false);

  // The address to send the other device: the hub itself, since this test opens
  // right here in the messenger.
  const address = useMemo(
    () => (typeof window === "undefined" ? "" : window.location.origin),
    [],
  );

  /* ------------------------------------------------------------- clean up */

  const stopMedia = useCallback(() => {
    setMedia((current) => {
      current?.getTracks().forEach((track) => track.stop());
      return null;
    });
  }, []);

  useEffect(
    () => () => {
      setMedia((current) => {
        current?.getTracks().forEach((track) => track.stop());
        return null;
      });
      void roomRef.current?.disconnect();
      loopbackRef.current?.a.close();
      loopbackRef.current?.b.close();
    },
    [],
  );

  /* --------------------------------------------------------- step one: media */

  const openMedia = useCallback(async () => {
    setMediaError(null);
    setMediaBusy(true);
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw Object.assign(new Error("unsupported"), {
          name: "NotSupportedError",
        });
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: { width: 1280, height: 720 },
      });
      setMedia((current) => {
        current?.getTracks().forEach((track) => track.stop());
        return stream;
      });
    } catch (caught) {
      const name = caught instanceof Error ? caught.name : "";
      setMediaError(
        name === "NotAllowedError" || name === "SecurityError"
          ? "The browser blocked the camera or microphone. Allow both for this site, then try again. The hub must be opened over https (or on localhost)."
          : name === "NotSupportedError"
            ? "This browser will not give a page a camera and microphone. Open the hub over https in Chrome, Edge, Firefox or Safari."
            : name === "NotFoundError"
              ? "No camera or microphone was found on this device."
              : name === "NotReadableError"
                ? "Another app is already using the camera or microphone. Close it and try again."
                : "The camera and microphone could not be opened.",
      );
    } finally {
      setMediaBusy(false);
    }
  }, []);

  /* -------------------------------------------------- step two: the relay */

  // Keep the room fed with whatever tracks are live right now, so a camera
  // granted after the room is open is published too.
  const publish = useCallback(async (room: Room, stream: MediaStream | null) => {
    if (!stream) return;
    for (const track of stream.getTracks()) {
      try {
        await room.localParticipant.publishTrack(track, { name: track.kind });
      } catch {
        // Already published, or the room refused it; a retry can take it.
      }
    }
  }, []);

  const joinRelay = useCallback(async () => {
    setRelayError(null);
    setRelayBusy(true);
    try {
      const result = await probe({});
      if (!result) {
        setRelayConfigured(false);
        setRelayHost(null);
        setRelayRoom(null);
        return;
      }

      setRelayConfigured(true);
      setRelayHost(safeHost(result.url));
      setRelayRoom(result.room);

      await roomRef.current?.disconnect();
      trackSets.current.clear();
      setRemoteStreams({});
      setPeers({});

      const room = new Room({ adaptiveStream: true, dynacast: true });
      roomRef.current = room;

      room
        .on(RoomEvent.ConnectionStateChanged, (state) => setRelayState(state))
        .on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
          const identity = participant.identity;
          let set = trackSets.current.get(identity);
          if (!set) {
            set = new Set<MediaStreamTrack>();
            trackSets.current.set(identity, set);
          }
          set.add(track.mediaStreamTrack);
          rebuild(trackSets, setRemoteStreams, identity);
        })
        .on(RoomEvent.TrackUnsubscribed, (track, _pub, participant) => {
          const identity = participant.identity;
          trackSets.current.get(identity)?.delete(track.mediaStreamTrack);
          rebuild(trackSets, setRemoteStreams, identity);
        })
        .on(RoomEvent.ParticipantConnected, (participant) => {
          setPeers((previous) => ({
            ...previous,
            [participant.identity]: participant.name || "Someone",
          }));
        })
        .on(RoomEvent.ParticipantDisconnected, (participant) => {
          const identity = participant.identity;
          trackSets.current.delete(identity);
          setRemoteStreams((previous) => {
            const next = { ...previous };
            delete next[identity];
            return next;
          });
          setPeers((previous) => {
            const next = { ...previous };
            delete next[identity];
            return next;
          });
        })
        .on(RoomEvent.Disconnected, () =>
          setRelayState(ConnectionState.Disconnected),
        );

      await room.connect(result.url, result.token);

      const present: Record<string, string> = {};
      room.remoteParticipants.forEach((participant) => {
        present[participant.identity] = participant.name || "Someone";
      });
      setPeers((previous) => ({ ...previous, ...present }));

      await publish(room, media);
      // A tap started this, so the browser will let the sound through.
      void room.startAudio().catch(() => undefined);
      setRelayState(room.state);
    } catch {
      setRelayState(ConnectionState.Disconnected);
      setRelayError(
        "The media server could not be reached. Check the URL and keys, or try again in a moment.",
      );
    } finally {
      setRelayBusy(false);
    }
  }, [media, probe, publish]);

  // Publish a camera opened after the room connected.
  useEffect(() => {
    const room = roomRef.current;
    if (!room || room.state !== ConnectionState.Connected) return;
    void publish(room, media);
  }, [media, publish]);

  const leaveRelay = useCallback(() => {
    void roomRef.current?.disconnect();
    roomRef.current = null;
    trackSets.current.clear();
    setRemoteStreams({});
    setPeers({});
    setRelayState(ConnectionState.Disconnected);
  }, []);

  /* ----------------------------------------------- step three: direct path */

  // Two real WebRTC connections wired to each other inside this page, each
  // sending its own camera to the other and decoding what comes back. This is
  // the same negotiation two separate devices do — offer, answer, candidates,
  // DTLS, SRTP — compressed onto one machine. Nothing is relayed, so it is the
  // honest "can this browser carry a call at all" check, and it still works
  // with no server configured. Every picture below arrived through that path.
  const runLoopback = useCallback(async () => {
    setLoopbackError(null);
    setLoopbackBusy(true);
    try {
      if (!media) {
        throw new Error("no media");
      }
      loopbackRef.current?.a.close();
      loopbackRef.current?.b.close();
      setLoopback(null);

      const a = new RTCPeerConnection();
      const b = new RTCPeerConnection();
      loopbackRef.current = { a, b };

      const toA = new MediaStream();
      const toB = new MediaStream();

      b.ontrack = (event) => {
        toB.addTrack(event.track);
        setLoopback({ toA, toB });
      };
      a.ontrack = (event) => {
        toA.addTrack(event.track);
        setLoopback({ toA, toB });
      };
      a.onicecandidate = (event) => {
        if (event.candidate)
          void b.addIceCandidate(event.candidate).catch(() => undefined);
      };
      b.onicecandidate = (event) => {
        if (event.candidate)
          void a.addIceCandidate(event.candidate).catch(() => undefined);
      };

      // Both ends send the same camera, so each must also receive a picture.
      for (const track of media.getTracks()) {
        a.addTrack(track, media);
        b.addTrack(track, media);
      }

      const offer = await a.createOffer();
      await a.setLocalDescription(offer);
      await b.setRemoteDescription(offer);
      const answer = await b.createAnswer();
      await b.setLocalDescription(answer);
      await a.setRemoteDescription(answer);
    } catch {
      setLoopbackError(
        "The direct connection could not be set up in this browser. Open the hub over https in Chrome, Edge, Firefox or Safari.",
      );
    } finally {
      setLoopbackBusy(false);
    }
  }, [media]);

  const copyAddress = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }, [address]);

  /* ------------------------------------------------------------------- ui */

  const secure = typeof window !== "undefined" && window.isSecureContext;
  const peerIds = Object.keys(peers);
  // The direct path's own relay. When none is set, the app falls back to a
  // free public one, which is worth saying out loud.
  const turnConfigured = Boolean(
    import.meta.env.VITE_TURN_URL as string | undefined,
  );

  return (
    <div className={cn("h-full w-full overflow-y-auto pr-1", className)}>
      <header className="mb-4 flex items-start gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-white/10 text-white">
          <PhoneCall className="size-4" />
        </span>
        <div className="min-w-0">
          <h1 className="text-[12px] font-semibold tracking-tight">Call test</h1>
          <p className="text-[10px] text-muted-foreground">
            Check one device, then the server, then a real second device — in
            that order. Nothing here is a mock-up; every picture on this panel
            came through a live connection.
          </p>
        </div>
      </header>

      {/* ------------------------------------------------ step one: device */}
      <Step
        index={1}
        title="This device"
        icon={<Camera className="size-4" />}
        state={media ? "ok" : mediaError ? "fail" : "idle"}
      >
        <p className="text-[10px] leading-4 text-muted-foreground">
          Open the camera and microphone. A live level under the picture must
          move when you talk — a still bar means the microphone is muted or
          blocked at the system level, not in the call.
        </p>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            type="button"
            disabled={mediaBusy}
            onClick={() => void openMedia()}
            className="h-9 cursor-pointer rounded-lg text-[11px]"
          >
            {mediaBusy ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Camera className="size-3.5" />
            )}
            {media ? "Open again" : "Open camera & microphone"}
          </Button>
          {media ? (
            <Button
              type="button"
              variant="outline"
              onClick={stopMedia}
              className="h-9 cursor-pointer rounded-lg text-[11px]"
            >
              Stop
            </Button>
          ) : null}
        </div>

        {media ? (
          <div className="mt-3 flex items-center gap-3">
            <VideoTile stream={media} muted label="You" />
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-1.5 text-[10px] font-medium">
                <Mic className="size-3" />
                {level > 0.02 ? "Microphone is hearing you" : "Say something…"}
              </p>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full bg-white transition-[width] duration-75"
                  style={{
                    width: `${Math.min(100, Math.round(level * 140))}%`,
                  }}
                />
              </div>
              <p className="mt-1.5 text-[9px] text-muted-foreground">
                Secure page: {secure ? "yes" : "no"}
              </p>
            </div>
          </div>
        ) : null}

        {mediaError ? <Note>{mediaError}</Note> : null}
      </Step>

      {/* ------------------------------------------------- step two: server */}
      <Step
        index={2}
        title="The media server"
        icon={<Server className="size-4" />}
        state={
          relayConfigured === false
            ? "warn"
            : relayState === ConnectionState.Connected
              ? "ok"
              : relayError
                ? "fail"
                : "idle"
        }
      >
        <p className="text-[10px] leading-4 text-muted-foreground">
          Two devices on two home networks usually cannot open a path to each
          other. The fix is a server every device connects <em>out</em> to. This
          button joins one fixed test room; open the hub on a phone or another
          computer, open this test there, press the same button, and you should
          see and hear each other here. That is the cross-location test.
        </p>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            type="button"
            disabled={relayBusy}
            onClick={() => void joinRelay()}
            className="h-9 cursor-pointer rounded-lg text-[11px]"
          >
            {relayBusy ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Server className="size-3.5" />
            )}
            {relayState === ConnectionState.Connected
              ? "Rejoin the test room"
              : "Join the test room"}
          </Button>
          {relayState === ConnectionState.Connected ? (
            <Button
              type="button"
              variant="outline"
              onClick={leaveRelay}
              className="h-9 cursor-pointer rounded-lg text-[11px]"
            >
              Leave
            </Button>
          ) : null}
          <Button
            type="button"
            variant="outline"
            onClick={() => void copyAddress()}
            className="h-9 cursor-pointer rounded-lg text-[11px]"
          >
            {copied ? (
              <Check className="size-3.5" />
            ) : (
              <Copy className="size-3.5" />
            )}
            {copied ? "Link copied" : "Copy the hub's link"}
          </Button>
        </div>

        <dl className="mt-3 grid gap-1.5 rounded-xl border border-border/60 bg-background/40 px-3 py-2.5 text-[10px]">
          <Row label="Server set up">
            {relayConfigured === null
              ? "not tried yet"
              : relayConfigured
                ? "yes"
                : "no"}
          </Row>
          <Row label="Server address">{relayHost ?? "—"}</Row>
          <Row label="Room">{relayRoom ?? "—"}</Row>
          <Row label="Connection">
            {relayState === ConnectionState.Connected
              ? "connected"
              : relayState === ConnectionState.Connecting
                ? "connecting…"
                : relayState === ConnectionState.Reconnecting
                  ? "reconnecting…"
                  : "not connected"}
          </Row>
          <Row label="Others in the room">{peerIds.length}</Row>
        </dl>

        {peerIds.length === 0 && relayState === ConnectionState.Connected ? (
          <Note>
            You are in the room alone. Open the hub on a second device, open
            this same test, and press Join — they will appear here with picture
            and sound.
          </Note>
        ) : null}

        {peerIds.length > 0 ? (
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
            {peerIds.map((identity) => (
              <VideoTile
                key={identity}
                stream={remoteStreams[identity] ?? null}
                muted={false}
                label={peers[identity] ?? "Someone"}
              />
            ))}
          </div>
        ) : null}

        {relayConfigured === false ? (
          <Note tone="warn">
            No media server is set up, so this is empty on purpose. Without one,
            calls can only work when the two networks can find each other — fine
            on the same wifi, unreliable between two homes. To switch it on, add
            its address and keys in the project's Keys tab:
            <span className="mt-1 block font-medium">
              LIVEKIT_URL · LIVEKIT_API_KEY · LIVEKIT_API_SECRET
            </span>
          </Note>
        ) : null}

        {relayError ? <Note tone="fail">{relayError}</Note> : null}
      </Step>

      {/* ------------------------------------------- step three: direct path */}
      <Step
        index={3}
        title="The direct path (no server)"
        icon={<ArrowLeftRight className="size-4" />}
        state={loopback ? "ok" : loopbackError ? "fail" : "idle"}
      >
        <p className="text-[10px] leading-4 text-muted-foreground">
          Two real WebRTC connections, head to head, each sending to the other
          and decoding what comes back — offer, answer, candidates, encryption,
          all of it, with no server in the middle. Both pictures below arrived
          through that path. If this works, the browser and the device can carry
          a call; a failure here means the device or the browser is the problem,
          not the network between two people.
        </p>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={loopbackBusy || !media}
            onClick={() => void runLoopback()}
            className="h-9 cursor-pointer rounded-lg text-[11px]"
          >
            {loopbackBusy ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
            Run the loopback
          </Button>
          {!media ? (
            <span className="text-[9px] text-muted-foreground">
              Open the camera in step 1 first.
            </span>
          ) : null}
        </div>

        {loopback ? (
          <div className="mt-3 grid max-w-[440px] grid-cols-2 gap-2">
            <VideoTile stream={loopback.toB} muted label="A → B, received" />
            <VideoTile stream={loopback.toA} muted label="B → A, received" />
          </div>
        ) : null}

        <dl className="mt-3 grid gap-1.5 rounded-xl border border-border/60 bg-background/40 px-3 py-2.5 text-[10px]">
          <Row label="Direct relay (TURN)">
            {turnConfigured ? "your own server" : "the free public one"}
          </Row>
          <Row label="Configure your own">
            VITE_TURN_URL · VITE_TURN_USERNAME · VITE_TURN_CREDENTIAL
          </Row>
        </dl>

        {loopbackError ? <Note tone="fail">{loopbackError}</Note> : null}
      </Step>

      <div className="mb-1 flex items-start gap-2 rounded-2xl border border-dashed border-border/70 px-3 py-2.5">
        <ShieldCheck className="mt-px size-3.5 shrink-0 text-muted-foreground" />
        <p className="text-[10px] leading-4 text-muted-foreground">
          Whatever route a call takes, the media stays encrypted in transit. The
          server only forwards it; it never holds a copy.
        </p>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- helpers */

function safeHost(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Rebuild one person's stream from whatever tracks are live right now. */
function rebuild(
  trackSets: { current: Map<string, Set<MediaStreamTrack>> },
  setRemote: Dispatch<SetStateAction<Record<string, MediaStream>>>,
  identity: string,
) {
  const set = trackSets.current.get(identity);
  setRemote((previous) => {
    const next = { ...previous };
    if (!set || set.size === 0) {
      delete next[identity];
      return next;
    }
    next[identity] = new MediaStream([...set]);
    return next;
  });
}

/** A live input level, so a working microphone is visible as a moving bar. */
function useMicLevel(stream: MediaStream | null, muted: boolean) {
  const [level, setLevel] = useState(0);

  useEffect(() => {
    if (!stream || muted || !stream.getAudioTracks().length) {
      setLevel(0);
      return;
    }

    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return;

    const audio = new Ctor();
    const analyser = audio.createAnalyser();
    analyser.fftSize = 512;
    audio.createMediaStreamSource(stream).connect(analyser);

    let frame = 0;
    const samples = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      analyser.getByteTimeDomainData(samples);
      let peak = 0;
      for (const sample of samples) {
        peak = Math.max(peak, Math.abs(sample - 128) / 128);
      }
      setLevel(peak);
      frame = requestAnimationFrame(tick);
    };
    tick();

    return () => {
      if (frame) cancelAnimationFrame(frame);
      void audio.close();
    };
  }, [stream, muted]);

  return level;
}

function Step({
  index,
  title,
  icon,
  state,
  children,
}: {
  index: number;
  title: string;
  icon: ReactNode;
  state: "idle" | "ok" | "warn" | "fail";
  children: ReactNode;
}) {
  return (
    <section className="mb-3 rounded-2xl border border-border/70 bg-card/70 p-4 backdrop-blur-sm">
      <div className="flex items-center gap-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-white/10 text-white">
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[12px] font-semibold tracking-tight">
            <span className="text-muted-foreground">{index}. </span>
            {title}
          </h2>
        </div>
        <Status state={state} />
      </div>
      <div className="mt-2.5">{children}</div>
    </section>
  );
}

function Status({ state }: { state: "idle" | "ok" | "warn" | "fail" }) {
  if (state === "ok") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-white/40 px-2 py-0.5 text-[9px]">
        <Check className="size-2.5" /> Pass
      </span>
    );
  }
  if (state === "fail") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-white/40 px-2 py-0.5 text-[9px]">
        <X className="size-2.5" /> Failed
      </span>
    );
  }
  if (state === "warn") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border/60 px-2 py-0.5 text-[9px] text-muted-foreground">
        <TriangleAlert className="size-2.5" /> Not set up
      </span>
    );
  }
  return (
    <span className="shrink-0 rounded-full border border-border/60 px-2 py-0.5 text-[9px] text-muted-foreground">
      Not run
    </span>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="w-36 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1 break-words">{children}</dd>
    </div>
  );
}

function Note({
  children,
  tone = "info",
}: {
  children: ReactNode;
  tone?: "info" | "warn" | "fail";
}) {
  return (
    <p
      className={cn(
        "mt-2.5 rounded-lg border border-dashed px-2.5 py-2 text-[10px] leading-4",
        tone === "info"
          ? "border-border/70 text-muted-foreground"
          : "border-white/25 text-foreground/80",
      )}
    >
      {children}
    </p>
  );
}

function VideoTile({
  stream,
  muted,
  label,
}: {
  stream: MediaStream | null;
  muted: boolean;
  label: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (element && element.srcObject !== stream) element.srcObject = stream;
    if (element && stream) void element.play().catch(() => undefined);
  }, [stream]);

  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-xl border border-border/60 bg-black/85">
      {stream ? (
        <video
          ref={ref}
          autoPlay
          playsInline
          muted={muted}
          className="size-full object-cover"
        />
      ) : (
        <div className="absolute inset-0 grid place-items-center">
          <Video className="size-4 text-white/30" />
        </div>
      )}
      <span className="absolute bottom-1.5 left-1.5 max-w-[85%] truncate rounded-md bg-black/65 px-1.5 py-0.5 text-[9px] font-medium text-white/90 backdrop-blur-sm">
        {label}
      </span>
    </div>
  );
}
