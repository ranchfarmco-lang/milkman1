import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useAuth } from "@/hooks/use-auth";
import { mintTurnCredentials } from "@/lib/turn-credentials";
import { useAction, useMutation, useQuery } from "convex/react";
import { ConnectionState, Room, RoomEvent } from "livekit-client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Phone and video calls.
 *
 * Two ways to carry the media, and the page does not care which is in use:
 *
 *   1. **The relay** (preferred). Every device connects *out* to a LiveKit
 *      room named after the call, and the server forwards the streams. This is
 *      the one that works from a strict home router, a phone on a carrier
 *      network, or a locked-down office — the places where two devices simply
 *      cannot open a path to each other. LiveKit is open source, so pointing
 *      LIVEKIT_URL at your own server makes the whole path yours.
 *
 *   2. **Straight between the devices** (our own WebRTC, the fallback). When no
 *      relay is configured, the two devices negotiate directly and the media
 *      never touches a server. Free, and private, but it only works when the
 *      two networks can find each other.
 *
 * Either way Convex carries only the handshake and the ring, and the media
 * stays encrypted in transit (DTLS-SRTP).
 */

/**
 * Free, public STUN servers, used by the direct path. They only tell a device
 * its own public address; nothing is relayed through them. A TURN relay is
 * offered as well, for when a direct path cannot be found — set
 * `VITE_TURN_URL` / `VITE_TURN_USERNAME` / `VITE_TURN_CREDENTIAL` (or
 * `VITE_TURN_SECRET`) to point at your own.
 */
const STUN_URLS = [
  "stun:stun.l.google.com:19302",
  "stun:stun1.l.google.com:19302",
  "stun:stun2.l.google.com:19302",
  "stun:stun3.l.google.com:3478",
  "stun:stun.cloudflare.com:3478",
];

/**
 * Open Relay's static-auth host and the public secret it publishes for exactly
 * this scheme — the same one Nextcloud Talk and Matrix use. The client mints a
 * short-lived username and HMAC credential from it, so no account or key is
 * needed. Point `VITE_TURN_URL` at your own TURN server to replace it.
 */
const OPEN_RELAY_HOST = "staticauth.openrelay.metered.ca";
const OPEN_RELAY_SECRET = "openrelayprojectsecret";

function rtcConfiguration(): RTCConfiguration {
  const turnUrl = import.meta.env.VITE_TURN_URL as string | undefined;
  const turnUsername = import.meta.env.VITE_TURN_USERNAME as
    | string
    | undefined;
  const turnCredential = import.meta.env.VITE_TURN_CREDENTIAL as
    | string
    | undefined;
  const turnSecret =
    (import.meta.env.VITE_TURN_SECRET as string | undefined) ??
    OPEN_RELAY_SECRET;

  const iceServers: RTCIceServer[] = [{ urls: STUN_URLS }];

  if (turnUrl) {
    const urls = turnUrl
      .split(",")
      .map((one) => one.trim())
      .filter(Boolean);
    if (urls.length) {
      iceServers.push({
        urls,
        username: turnUsername,
        credential: turnCredential,
      });
    }
  } else {
    const { username, credential } = mintTurnCredentials(turnSecret);
    iceServers.push({
      urls: [
        `turn:${OPEN_RELAY_HOST}:80`,
        `turn:${OPEN_RELAY_HOST}:443`,
        `turn:${OPEN_RELAY_HOST}:443?transport=tcp`,
        `turns:${OPEN_RELAY_HOST}:443?transport=tcp`,
      ],
      username,
      credential,
    });
  }

  return { iceServers, iceCandidatePoolSize: 2 };
}

/** How long to ring before giving up if nobody picks up. */
const RING_TIMEOUT_MS = 45_000;

export type CallState =
  | "idle"
  | "ringing"
  | "connecting"
  | "connected"
  | "failed";

type Peer = {
  connection: RTCPeerConnection;
  audio: HTMLAudioElement;
  /** True once this side has been told to make the offer. */
  polite: boolean;
  /**
   * True once this side has started negotiating with this peer. A later join
   * changes the member list, which re-runs the effect below; without this flag
   * that re-run would fire a fresh offer at a peer that is already connected,
   * and the two overlapping handshakes corrupt each other.
   */
  initiated: boolean;
  /**
   * True once the other side's description has been applied. Until then any
   * network candidate that arrives is held here rather than handed to the
   * connection — adding a candidate before the remote description exists is
   * rejected, and dropping those candidates is what leaves a call with a
   * connection but no sound and no picture.
   */
  remoteReady: boolean;
  pending: RTCIceCandidateInit[];
  /** True while this side is re-offering after the connection dropped. */
  restarting: boolean;
};

/** True when this browser can actually open a camera or a microphone. */
function mediaAvailable() {
  return Boolean(
    typeof navigator !== "undefined" && navigator.mediaDevices?.getUserMedia,
  );
}

export type CallController = ReturnType<typeof useCall>;

export function useCall() {
  const { user } = useAuth();
  const myId = user?._id ?? null;

  const current = useQuery(api.calls.current);
  const callId = current?.callId ?? null;

  const signals = useQuery(api.calls.signals, callId ? { callId } : "skip");

  const startCall = useMutation(api.calls.start);
  const joinCall = useMutation(api.calls.join);
  const answerCall = useMutation(api.calls.answer);
  const declineCall = useMutation(api.calls.decline);
  const leaveCall = useMutation(api.calls.leave);
  const endCall = useMutation(api.calls.end);
  const sendSignal = useMutation(api.calls.signal);
  /** The relay's URL and token, or nothing when no relay is set up. */
  const getCallToken = useAction(api.livekit.token);

  const [muted, setMuted] = useState(false);
  const [speaker, setSpeaker] = useState(true);
  const [cameraOn, setCameraOn] = useState(true);
  const [remoteStreams, setRemoteStreams] = useState<
    Record<string, MediaStream>
  >({});
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  /** Bumping this asks the media effect to try the camera again. */
  const [mediaNonce, setMediaNonce] = useState(0);
  /**
   * Which way the media travels, decided the moment a call is joined: the
   * relay when one is configured and reachable, our own direct connection
   * otherwise. `pending` is the moment before that answer, when neither runs.
   */
  const [transport, setTransport] = useState<"pending" | "p2p" | "livekit">(
    "pending",
  );
  /** Bumping this asks the relayed room to be torn down and joined again. */
  const [connectionNonce, setConnectionNonce] = useState(0);

  const peersRef = useRef(new Map<string, Peer>());
  /** Set to the current restart function so a failed link can renegotiate. */
  const restartRef = useRef<((themId: string) => void) | null>(null);
  const seenRef = useRef(new Set<string>());
  const streamRef = useRef<MediaStream | null>(null);
  const callIdRef = useRef<string | null>(null);
  const speakerRef = useRef(speaker);
  // Mirrored in an effect, not written during render: a render can be discarded
  // or replayed, and a ref written on the way past would keep the value of a
  // render that never happened.
  useEffect(() => {
    speakerRef.current = speaker;
  }, [speaker]);

  /* ------------------------------------------------------------ the relay */

  const roomRef = useRef<Room | null>(null);
  const tokenRef = useRef<{ url: string; token: string } | null>(null);
  /** Remote audio elements, so the sound can be muted and cleaned up. */
  const remoteAudioRef = useRef(new Map<string, HTMLAudioElement>());
  /** The live remote tracks per person, so a MediaStream can be rebuilt. */
  const remoteTracksRef = useRef(new Map<string, Set<MediaStreamTrack>>());
  /** Local tracks already handed to the relay, so none is published twice. */
  const publishedRef = useRef(new Set<string>());

  const joined = current?.myState === "joined";
  const kind = current?.kind ?? "audio";
  const others = (current?.people ?? []).filter(
    (one) => one.state === "joined" && one.userId !== myId,
  );
  const otherKey = others
    .map((one) => one.userId)
    .sort()
    .join(",");

  const teardown = useCallback(() => {
    for (const peer of peersRef.current.values()) {
      peer.connection.onicecandidate = null;
      peer.connection.ontrack = null;
      peer.connection.onconnectionstatechange = null;
      peer.connection.close();
      peer.audio.pause();
      peer.audio.srcObject = null;
    }
    peersRef.current.clear();
    seenRef.current.clear();

    const room = roomRef.current;
    if (room) {
      for (const element of remoteAudioRef.current.values()) element.remove();
      remoteAudioRef.current.clear();
      remoteTracksRef.current.clear();
      void room.disconnect();
      roomRef.current = null;
    }
    publishedRef.current.clear();
    tokenRef.current = null;

    setRemoteStreams({});
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setLocalStream(null);
  }, []);

  // Closing the page hangs up; a call cannot outlive the tab.
  useEffect(() => {
    const bail = () => {
      const id = callIdRef.current;
      if (id) void leaveCall({ callId: id as Id<"calls"> });
      teardown();
    };
    window.addEventListener("pagehide", bail);
    return () => {
      window.removeEventListener("pagehide", bail);
      teardown();
    };
  }, [leaveCall, teardown]);

  // Keep a handle on the call id for the pagehide handler.
  useEffect(() => {
    callIdRef.current = callId;
    if (!callId) {
      teardown();
      setProblem(null);
      setFailure(null);
      setMuted(false);
      setSpeaker(true);
      setCameraOn(true);
      setTransport("pending");
    }
  }, [callId, teardown]);

  /* --------------------------------------------------- choosing the route */

  // Ask the server for a relay token. Getting one means the relay is set up and
  // this person is on this call, so the media goes through the room; getting
  // nothing means there is no relay, and the devices connect straight to each
  // other instead. A failure is treated the same as "no relay" rather than as
  // an error — a call should always come up one way or the other.
  useEffect(() => {
    if (!joined || !callId || !myId) {
      setTransport("pending");
      return;
    }

    let cancelled = false;
    setTransport("pending");

    void (async () => {
      try {
        const result = await getCallToken({ callId: callId as Id<"calls"> });
        if (cancelled) return;
        if (result?.url && result.token) {
          tokenRef.current = { url: result.url, token: result.token };
          setTransport("livekit");
        } else {
          tokenRef.current = null;
          setTransport("p2p");
        }
      } catch {
        if (!cancelled) {
          tokenRef.current = null;
          setTransport("p2p");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [joined, callId, myId, getCallToken]);

  /* --------------------------------------------------- the local microphone */

  useEffect(() => {
    if (!joined || !callId || streamRef.current) return;

    let cancelled = false;
    setProblem(null);

    if (!mediaAvailable()) {
      setProblem(
        "This browser will not give a page a camera or microphone. Open the hub over https (or on localhost) in Chrome, Edge, Firefox or Safari.",
      );
      return;
    }

    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: kind === "video" ? { width: 1280, height: 720 } : false,
        });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        setLocalStream(stream);
      } catch (error) {
        if (cancelled) return;
        const name = error instanceof Error ? error.name : "";
        setProblem(
          name === "NotAllowedError" || name === "SecurityError"
            ? "Your browser blocked the camera or microphone. Allow them for this site, then tap Try again."
            : name === "NotFoundError"
              ? "No camera or microphone was found on this device."
              : name === "NotReadableError"
                ? "Another app is already using the camera or microphone. Close it, then tap Try again."
                : "This device would not give the call a microphone or camera.",
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [joined, callId, kind, mediaNonce]);

  // Mute is real: it switches the live microphone track off at the source.
  // The very same track is what the relay carries, so this mutes it there too.
  useEffect(() => {
    streamRef.current
      ?.getAudioTracks()
      .forEach((track) => {
        track.enabled = !muted;
      });
  }, [muted, localStream]);

  // Switching the camera off stops sending a picture without dropping the call:
  // the track stays live, it just carries black.
  useEffect(() => {
    streamRef.current
      ?.getVideoTracks()
      .forEach((track) => {
        track.enabled = cameraOn;
      });
  }, [cameraOn, localStream]);

  // The speaker switch decides whether the other end is heard at all, on
  // whichever route the media is taking.
  useEffect(() => {
    for (const peer of peersRef.current.values()) {
      peer.audio.muted = !speaker;
    }
    for (const element of remoteAudioRef.current.values()) {
      element.muted = !speaker;
    }
  }, [speaker, remoteStreams]);

  /* --------------------------------------------------- the relayed room */

  /** Hand the local tracks to the room, once each. */
  const publishLocal = useCallback(async (room: Room) => {
    const stream = streamRef.current;
    if (!stream) return;
    for (const track of stream.getTracks()) {
      if (publishedRef.current.has(track.id)) continue;
      try {
        await room.localParticipant.publishTrack(track, { name: track.kind });
        publishedRef.current.add(track.id);
      } catch {
        // Already published, or the room refused it; a later pass can retry.
      }
    }
  }, []);

  useEffect(() => {
    if (transport !== "livekit" || !joined || !callId || !myId) return;
    if (!tokenRef.current) return;

    let cancelled = false;
    const room = new Room({ adaptiveStream: true, dynacast: true });
    roomRef.current = room;

    const audioElements = remoteAudioRef.current;
    const trackSets = remoteTracksRef.current;

    // Rebuild one person's picture from whatever tracks are live right now.
    // The grid keeps reading `remoteStreams`, exactly as it does for the
    // direct path, so the four boxes never need to know which route is in use.
    const rebuild = (identity: string) => {
      const tracks = trackSets.get(identity);
      if (!tracks || tracks.size === 0) {
        setRemoteStreams((previous) => {
          const next = { ...previous };
          delete next[identity];
          return next;
        });
        return;
      }
      const stream = new MediaStream([...tracks]);
      setRemoteStreams((previous) => ({ ...previous, [identity]: stream }));
    };

    room
      .on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
        const identity = participant.identity;
        const media = track.mediaStreamTrack;

        let set = trackSets.get(identity);
        if (!set) {
          set = new Set<MediaStreamTrack>();
          trackSets.set(identity, set);
        }
        set.add(media);

        if (track.kind === "audio") {
          const element = track.attach() as HTMLAudioElement;
          element.autoplay = true;
          element.muted = !speakerRef.current;
          element.style.display = "none";
          document.body.appendChild(element);
          audioElements.set(media.id, element);
        }

        rebuild(identity);
      })
      .on(RoomEvent.TrackUnsubscribed, (track, _publication, participant) => {
        const identity = participant.identity;
        const media = track.mediaStreamTrack;
        trackSets.get(identity)?.delete(media);

        const element = audioElements.get(media.id);
        if (element) {
          element.remove();
          audioElements.delete(media.id);
        }
        track.detach().forEach((node) => node.remove());

        rebuild(identity);
      })
      .on(RoomEvent.ParticipantDisconnected, (participant) => {
        // They are gone: drop their tracks so the box goes back to empty
        // rather than holding a frozen last frame.
        trackSets.delete(participant.identity);
        rebuild(participant.identity);
      });

    void (async () => {
      try {
        const credentials = tokenRef.current;
        if (!credentials) return;
        await room.connect(credentials.url, credentials.token);
        if (cancelled) return;
        await publishLocal(room);
      } catch {
        if (!cancelled) {
          setFailure("The relayed connection could not be made.");
        }
      }
    })();

    return () => {
      cancelled = true;
      for (const element of audioElements.values()) element.remove();
      audioElements.clear();
      trackSets.clear();
      setRemoteStreams({});
      void room.disconnect();
      if (roomRef.current === room) roomRef.current = null;
    };
  }, [transport, joined, callId, myId, connectionNonce, publishLocal]);

  // If the camera is granted after the room is already open, publish then.
  useEffect(() => {
    if (transport !== "livekit" || !localStream) return;
    const room = roomRef.current;
    if (!room || room.state !== ConnectionState.Connected) return;
    void publishLocal(room);
  }, [transport, localStream, publishLocal]);

  /* --------------------------------------------------------- the handshake */

  const addPeer = useCallback(
    (themId: string) => {
      const existing = peersRef.current.get(themId);
      if (existing) return existing;

      const connection = new RTCPeerConnection(rtcConfiguration());
      const audio = new Audio();
      audio.autoplay = true;
      audio.muted = false;

      const peer: Peer = {
        connection,
        audio,
        // The lower id makes the offer, so both sides never offer at once.
        polite: myId !== null && myId > themId,
        initiated: false,
        remoteReady: false,
        pending: [],
        restarting: false,
      };
      peersRef.current.set(themId, peer);

      const stream = streamRef.current;
      if (stream) {
        for (const track of stream.getTracks()) {
          connection.addTrack(track, stream);
        }
      }

      connection.onicecandidate = (event) => {
        if (!event.candidate || !callId) return;
        void sendSignal({
          callId: callId as Id<"calls">,
          toId: themId as Id<"users">,
          kind: "ice",
          payload: JSON.stringify(event.candidate.toJSON()),
        });
      };

      connection.ontrack = (event) => {
        const incoming = event.streams[0] ?? new MediaStream([event.track]);
        audio.srcObject = incoming;
        audio.muted = !speakerRef.current;
        void audio.play().catch(() => {
          // Autoplay was refused; the next tap on the panel will start it.
        });
        setRemoteStreams((previous) => ({
          ...previous,
          [themId]: incoming,
        }));
      };

      connection.onconnectionstatechange = () => {
        const state = connection.connectionState;
        if (state === "connected") {
          peer.restarting = false;
          setFailure(null);
        } else if (state === "failed") {
          setFailure(
            "The direct path did not work — trying a relayed connection.",
          );
          // Re-gather and re-offer. A new set of candidates, including the
          // relay, is the one thing that can rescue a link that found no path.
          restartRef.current?.(themId);
        }
      };

      return peer;
    },
    [callId, myId, sendSignal],
  );

  /** The lower id re-offers with an ICE restart after a link fails. */
  const restartPeer = useCallback(
    (themId: string) => {
      const peer = peersRef.current.get(themId);
      if (!peer || peer.polite || peer.restarting || !callId || !myId) return;
      peer.restarting = true;
      void (async () => {
        try {
          const offer = await peer.connection.createOffer({ iceRestart: true });
          await peer.connection.setLocalDescription(offer);
          await sendSignal({
            callId: callId as Id<"calls">,
            toId: themId as Id<"users">,
            kind: "offer",
            payload: JSON.stringify(offer),
          });
        } catch {
          // Let a later attempt try again.
          peer.restarting = false;
        }
      })();
    },
    [callId, myId, sendSignal],
  );

  useEffect(() => {
    restartRef.current = restartPeer;
  }, [restartPeer]);

  // Apply the other side's description, then release the candidates that were
  // waiting on it. This is the one ordering that matters: a candidate added
  // before the description throws and is lost for good.
  const applyRemote = useCallback(async (peer: Peer, payload: string) => {
    await peer.connection.setRemoteDescription(
      JSON.parse(payload) as RTCSessionDescriptionInit,
    );
    peer.remoteReady = true;
    const queued = peer.pending;
    peer.pending = [];
    for (const candidate of queued) {
      try {
        await peer.connection.addIceCandidate(candidate);
      } catch {
        // A stale candidate is safe to drop; the rest still land.
      }
    }
  }, []);

  // Every joined pair gets a connection, negotiated by whoever has the lower
  // id. Only on the direct route — the relayed room does all of this itself.
  useEffect(() => {
    if (transport !== "p2p") return;
    if (!joined || !callId || !myId || !streamRef.current) return;

    for (const other of others) {
      const peer = addPeer(other.userId);
      // Only start a handshake once per peer. Someone joining later must not
      // renegotiate the connections that are already up.
      if (peer.polite || peer.initiated) continue;
      peer.initiated = true;
      if (peer.connection.signalingState !== "stable") continue;

      void (async () => {
        try {
          const offer = await peer.connection.createOffer();
          await peer.connection.setLocalDescription(offer);
          await sendSignal({
            callId: callId as Id<"calls">,
            toId: other.userId as Id<"users">,
            kind: "offer",
            payload: JSON.stringify(offer),
          });
        } catch {
          // The handshake could not even be written; let a retry take it.
          peer.initiated = false;
        }
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transport, joined, callId, myId, otherKey, localStream]);

  // Deal with whatever the other devices sent us. Only the direct route reads
  // handshake messages; the relay needs none of them.
  //
  // Strictly one at a time, in order. An offer has to be applied before the
  // network candidates that follow it, or the connection is built on a
  // description that is not there yet and the call never comes up.
  const [drained, setDrained] = useState(0);
  const busyRef = useRef(false);

  useEffect(() => {
    if (transport !== "p2p") return;
    if (!callId || !signals || !myId || busyRef.current) return;
    // Wait for our own microphone and camera before answering anyone. A peer
    // connection built without our tracks would carry nothing, and a late
    // joiner is the most likely to still be waiting on the permission prompt.
    if (!streamRef.current && !problem) return;

    const queue = signals.filter((one) => !seenRef.current.has(one._id));
    if (!queue.length) return;

    busyRef.current = true;
    void (async () => {
      for (const signal of queue) {
        seenRef.current.add(signal._id);
        const themId = signal.fromId as string;
        const peer = addPeer(themId);

        try {
          if (signal.kind === "offer") {
            await applyRemote(peer, signal.payload);
            const answer = await peer.connection.createAnswer();
            await peer.connection.setLocalDescription(answer);
            await sendSignal({
              callId: callId as Id<"calls">,
              toId: themId as Id<"users">,
              kind: "answer",
              payload: JSON.stringify(answer),
            });
            continue;
          }

          if (signal.kind === "answer") {
            if (peer.connection.signalingState === "have-local-offer") {
              await applyRemote(peer, signal.payload);
            }
            continue;
          }

          // A network candidate. Hold it until the description is in place.
          const candidate = JSON.parse(
            signal.payload,
          ) as RTCIceCandidateInit;
          if (peer.remoteReady) {
            await peer.connection.addIceCandidate(candidate);
          } else {
            peer.pending.push(candidate);
          }
        } catch {
          // A late or duplicated signal is normal and safe to drop.
        }
      }
    })().finally(() => {
      busyRef.current = false;
      // Anything that landed while we were working gets picked up next.
      setDrained((count) => count + 1);
    });
  }, [
    addPeer,
    applyRemote,
    callId,
    drained,
    localStream,
    myId,
    problem,
    sendSignal,
    signals,
    transport,
  ]);

  /* -------------------------------------------------------------- controls */

  // A browser only starts playing sound after the person has touched the page.
  // Every call button is a touch, so this is where the other end's audio gets
  // unpaused — the relayed room included.
  const resumeAudio = useCallback(() => {
    for (const peer of peersRef.current.values()) {
      peer.audio.muted = !speakerRef.current;
      void peer.audio.play().catch(() => {
        // Nothing to do; the next tap will try again.
      });
    }
    const room = roomRef.current;
    if (room) void room.startAudio().catch(() => undefined);
    for (const element of remoteAudioRef.current.values()) {
      element.muted = !speakerRef.current;
      void element.play().catch(() => undefined);
    }
  }, []);

  /** Ask for the camera and microphone again after a refusal or a busy device. */
  const retryMedia = useCallback(() => {
    setProblem(null);
    setMediaNonce((count) => count + 1);
  }, []);

  /** Rebuild the connection by hand, on whichever route is in use. */
  const retryConnection = useCallback(() => {
    setFailure(null);
    if (transport === "livekit") {
      setConnectionNonce((count) => count + 1);
      return;
    }
    for (const [themId, peer] of peersRef.current) {
      // A peer is a live WebRTC object kept in a ref, not a value React owns or
      // renders, so clearing its flag here is the point of the call — the rule
      // cannot tell a ref's mutable contents from rendered state.
      // eslint-disable-next-line react-hooks/immutability -- a ref's contents are outside React
      peer.restarting = false;
      if (!peer.polite) restartPeer(themId);
    }
  }, [restartPeer, transport]);

  const ring = useCallback(
    async (nextKind: "audio" | "video", to: string[]) => {
      if (!to.length) {
        setProblem("There is nobody else to call yet.");
        return;
      }
      setFailure(null);
      setMuted(false);
      setSpeaker(true);
      setCameraOn(true);
      await startCall({
        kind: nextKind,
        to: to as Id<"users">[],
      });
    },
    [startCall],
  );

  /** Get on the standing video room and wait for the rest to turn up. */
  const joinRoom = useCallback(() => {
    setFailure(null);
    setMuted(false);
    setSpeaker(true);
    setCameraOn(true);
    resumeAudio();
    void joinCall({});
  }, [joinCall, resumeAudio]);

  const answer = useCallback(() => {
    resumeAudio();
    if (callId) void answerCall({ callId: callId as Id<"calls"> });
  }, [answerCall, callId, resumeAudio]);

  const hangUp = useCallback(() => {
    if (!callId) return;
    void endCall({ callId: callId as Id<"calls"> });
    teardown();
  }, [callId, endCall, teardown]);

  const decline = useCallback(() => {
    if (!callId) return;
    void declineCall({ callId: callId as Id<"calls"> });
    teardown();
  }, [callId, declineCall, teardown]);

  // A ringing call nobody answers gives up on its own. A standing room never
  // does — waiting for the others to turn up is the whole point of it.
  useEffect(() => {
    if (!current || current.myState !== "joined") return;
    if (current.room) return;
    if (current.joined >= 2) return;
    if (current.startedBy !== myId) return;

    const timer = window.setTimeout(() => {
      void endCall({ callId: current.callId as Id<"calls"> });
    }, RING_TIMEOUT_MS);

    return () => window.clearTimeout(timer);
  }, [current, endCall, myId]);

  const state: CallState = !current
    ? "idle"
    : current.incoming
      ? "ringing"
      : failure
        ? "failed"
        : (current.joined ?? 0) >= 2
          ? "connected"
          : "connecting";

  return useMemo(
    () => ({
      state,
      current,
      kind,
      problem,
      failure,
      muted,
      speaker,
      cameraOn,
      setMuted,
      setSpeaker,
      setCameraOn,
      localStream,
      remoteStreams,
      others,
      ring,
      joinRoom,
      answer,
      decline,
      hangUp,
      retryMedia,
      retryConnection,
      /** Which way the media is travelling, so a page can say it plainly. */
      transport,
    }),
    [
      state,
      current,
      kind,
      problem,
      failure,
      muted,
      speaker,
      cameraOn,
      localStream,
      remoteStreams,
      others,
      ring,
      joinRoom,
      answer,
      decline,
      hangUp,
      retryMedia,
      retryConnection,
      transport,
    ],
  );
}
