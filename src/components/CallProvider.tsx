import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/convex/_generated/api";
import type { FamilyMember } from "@/convex/family";
import { useCall } from "@/hooks/use-call";
import { notifyCall, ringtone } from "@/lib/alerts";
import { cn } from "@/lib/utils";
import { useQuery } from "convex/react";
import {
  Camera,
  Loader2,
  Mic,
  MicOff,
  Phone,
  PhoneOff,
  RotateCw,
  Video,
} from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useLocation } from "react-router";

/**
 * Calling: our own video boxes, drawn by our own code.
 *
 * The four-portal grid, the ring, the handshake (carried by our own Convex
 * backend) and the media engine are all ours — nothing here is a third-party
 * widget. The media itself is encrypted end to end, either straight between the
 * devices or through a media server that every device connects out to (see
 * `use-call.ts`), which is what makes it work from behind a strict router.
 */

/* ------------------------------------------------------------- microphone */

/** A live level for a stream, so the panel shows that a microphone is working. */
function useLevel(stream: MediaStream | null, muted: boolean) {
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

/* ------------------------------------------------------------- the buttons */

type CallKind = "audio" | "video";

type CallApi = {
  /** Open the "who do you want to call" list. */
  openPicker: (kind: CallKind) => void;
  /** Ring one person straight away. */
  ringOne: (kind: CallKind, userId: string) => void;
  /** Ring the whole family at once — a one-off group call. */
  ringEveryone: (kind: CallKind) => void;
  /** Get on the standing video room and wait for the rest to turn up. */
  joinRoom: () => void;
};

const CallContext = createContext<CallApi>({
  openPicker: () => undefined,
  ringOne: () => undefined,
  ringEveryone: () => undefined,
  joinRoom: () => undefined,
});

/**
 * The live call, so the messenger can draw the four-portal video stage itself
 * instead of relying on the pop-up panel. Null whenever nothing is ringing or
 * live.
 */
const CallStageContext = createContext<ReturnType<typeof useCall> | null>(null);

/** Used by the phone and video buttons anywhere in the app. */
export function useCallApi() {
  return useContext(CallContext);
}

/** The live call, so the messenger can show the four-portal video stage. */
export function useCallStage() {
  return useContext(CallStageContext);
}

/* ---------------------------------------------------------------- provider */

export function CallProvider({ children }: { children: ReactNode }) {
  const family = useQuery(api.family.mine);
  const members: FamilyMember[] = family?.members ?? [];

  const call = useCall();
  const location = useLocation();
  const [picker, setPicker] = useState<CallKind | null>(null);

  const openPicker = useCallback((kind: CallKind) => setPicker(kind), []);

  const others = members.filter((member) => !member.isMe);
  const onlineOthers = others.filter((member) => member.online).length;

  const ringOne = useCallback(
    (kind: CallKind, userId: string) => {
      setPicker(null);
      void call.ring(kind, [userId]);
    },
    [call],
  );

  // Ring the whole family at once — but only the people who are here. Ringing
  // someone who is not around just leaves a call hanging until the ring times
  // out, so the offline rows are left alone.
  const ringEveryone = useCallback(
    (kind: CallKind) => {
      setPicker(null);
      void call.ring(
        kind,
        others.filter((member) => member.online).map((member) => member._id),
      );
    },
    [call, others],
  );

  const joinRoom = useCallback(() => {
    setPicker(null);
    call.joinRoom();
  }, [call]);

  const inCall = call.current !== null;
  const incoming = call.current?.incoming === true;
  const callerName = call.current?.startedByName ?? "Someone";
  // Three or more invited is a conference, not a one-to-one call.
  const conference = (call.current?.people.length ?? 0) > 2;

  // A call ringing at you plays a ring and raises a notification, so nobody has
  // to be staring at this tab to know they are wanted. Both stop the moment the
  // call is answered, declined or gone.
  useEffect(() => {
    if (!incoming) return;
    void notifyCall(
      `Incoming ${conference ? "conference " : ""}${call.kind} call`,
      `${callerName} is calling you — open the hub to join.`,
    );
    return ringtone();
  }, [incoming, callerName, conference, call.kind]);

  // The messenger draws the four-portal stage itself, alongside the transcript.
  // There, the call lives entirely inside the portals — every button is there —
  // and the pop-up panel steps out of the way instead of opening a second,
  // smaller view on top of it.
  const stagePage = location.pathname === "/messenger";

  const stageOwnsCall =
    inCall &&
    call.kind === "video" &&
    call.current?.myState === "joined" &&
    !incoming &&
    stagePage;
  const pageAnswersRing = incoming && call.kind === "video" && stagePage;

  const open = picker !== null || (inCall && !stageOwnsCall && !pageAnswersRing);

  // Closing the panel while it matters means hanging up, so nothing is left
  // ringing in the background with no way back to it. The one exception is the
  // portals taking the call over — that is not a hang-up.
  const close = () => {
    setPicker(null);
    if (stageOwnsCall || pageAnswersRing) return;
    if (incoming) call.decline();
    else if (inCall) call.hangUp();
  };

  return (
    <CallContext.Provider
      value={{ openPicker, ringOne, ringEveryone, joinRoom }}
    >
      <CallStageContext.Provider value={call}>
        {children}

        <Dialog open={open} onOpenChange={(next) => (next ? undefined : close())}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="text-[13px]">
                {title(call, picker)}
              </DialogTitle>
              <DialogDescription className="text-[11px] leading-4">
                {subtitle(call, picker)}
              </DialogDescription>
            </DialogHeader>

            {inCall ? (
              <ActiveCall call={call} />
            ) : (
              <>
                <ul className="flex flex-col gap-1">
                  {others.length === 0 ? (
                    <li className="rounded-xl border border-dashed border-border/70 px-3 py-2.5 text-[10px] leading-4 text-muted-foreground">
                      Nobody else is here yet — they will appear as soon as they
                      join.
                    </li>
                  ) : (
                    <>
                      <li>
                        <PickerRow
                          name="Everyone"
                          detail={`${others.length} in the family · ${onlineOthers} online`}
                          icon={<Video className="size-3.5" />}
                          onClick={() =>
                            picker === "video"
                              ? joinRoom()
                              : ringEveryone("audio")
                          }
                        />
                      </li>
                      {others.map((member) => (
                        <li key={member._id}>
                          <PickerRow
                            name={member.name}
                            detail={member.online ? "Online" : "Offline"}
                            dim={!member.online}
                            icon={<Phone className="size-3.5" />}
                            onClick={() => picker && ringOne(picker, member._id)}
                          />
                        </li>
                      ))}
                    </>
                  )}
                </ul>
                <MediaCheck />
              </>
            )}
          </DialogContent>
        </Dialog>
      </CallStageContext.Provider>
    </CallContext.Provider>
  );
}

/* ----------------------------------------------------------------- pieces */

function title(
  call: ReturnType<typeof useCall>,
  picker: CallKind | null,
) {
  if (call.current?.incoming) {
    const many = (call.current.people.length ?? 0) > 2;
    return `Incoming ${many ? "conference " : ""}${call.kind} call`;
  }
  if (call.current) {
    return `${call.kind === "video" ? "Video" : "Voice"} call · ${
      call.current.joined
    } in`;
  }
  return picker === "video" ? "Start a video call" : "Start a voice call";
}

function subtitle(
  call: ReturnType<typeof useCall>,
  picker: CallKind | null,
) {
  if (call.current?.incoming) {
    return `${call.current.startedByName} is calling. A call happens alongside the room — everyone stays in the one thread.`;
  }
  if (call.current) {
    return call.state === "connected"
      ? "Connected — encrypted end to end."
      : call.state === "failed"
        ? "The direct connection could not be made."
        : "Ringing…";
  }
  return picker === "video"
    ? "Pick who to call. Everyone is still in the same message room."
    : "Pick who to call. Everyone is still in the same message room.";
}

function PickerRow({
  name,
  detail,
  icon,
  dim = false,
  onClick,
}: {
  name: string;
  detail: string;
  icon: ReactNode;
  dim?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left transition-colors hover:bg-accent/40"
    >
      <span
        className={cn(
          "grid size-8 shrink-0 place-items-center rounded-full",
          dim ? "bg-muted text-muted-foreground" : "bg-white/10 text-white",
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px] font-medium">{name}</span>
        <span className="block truncate text-[9px] text-muted-foreground">
          {detail}
        </span>
      </span>
      <Phone className="size-3.5 shrink-0 text-muted-foreground" />
    </button>
  );
}

/**
 * A quick, honest check that this device can actually take a call: it opens the
 * camera and microphone, shows the local picture and a live level, and says
 * plainly when the browser refuses. It is the fastest way to tell a broken
 * permission from a broken call.
 */
function MediaCheck() {
  const [state, setState] = useState<"idle" | "running" | "live">("idle");
  const [error, setError] = useState<string | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const level = useLevel(stream, false);

  useEffect(() => {
    if (videoRef.current && stream) videoRef.current.srcObject = stream;
  }, [stream]);

  const stop = useCallback(() => {
    setStream((current) => {
      current?.getTracks().forEach((track) => track.stop());
      return null;
    });
    setState("idle");
  }, []);

  // Never leave the camera light on when the dialog closes.
  useEffect(
    () => () => {
      setStream((current) => {
        current?.getTracks().forEach((track) => track.stop());
        return null;
      });
    },
    [],
  );

  const start = useCallback(async () => {
    setError(null);
    setState("running");
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw Object.assign(new Error("no media"), {
          name: "NotSupportedError",
        });
      }
      const media = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: { width: 640, height: 360 },
      });
      setStream(media);
      setState("live");
    } catch (caught) {
      const name = caught instanceof Error ? caught.name : "";
      setError(
        name === "NotAllowedError" || name === "SecurityError"
          ? "The browser blocked the camera or microphone. Allow both for this site, then try again."
          : name === "NotSupportedError"
            ? "This browser or page cannot use a camera. Open the hub over https in Chrome, Edge, Firefox or Safari."
            : name === "NotFoundError"
              ? "No camera or microphone was found on this device."
              : name === "NotReadableError"
                ? "Another app is already using the camera or microphone. Close it and try again."
                : "The camera and microphone could not be opened.",
      );
      setState("idle");
    }
  }, []);

  return (
    <div className="mt-3 border-t border-border/60 pt-3">
      <div className="flex items-center gap-2">
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground">
          <Camera className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[11px] font-medium">
            Camera &amp; microphone
          </p>
          <p className="truncate text-[9px] text-muted-foreground">
            {state === "live"
              ? level > 0.02
                ? "Working — your microphone is picking you up"
                : "Camera on — say something to test the microphone"
              : "Check this device before you call"}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={state === "running"}
          onClick={state === "live" ? stop : () => void start()}
          className="h-8 shrink-0 gap-1.5 rounded-xl text-[11px]"
        >
          {state === "running" ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Camera className="size-3.5" />
          )}
          {state === "live" ? "Stop" : "Test"}
        </Button>
      </div>

      {stream ? (
        <div className="mt-2 flex items-center gap-2">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className="aspect-video w-28 rounded-lg border border-border/60 bg-black object-cover"
          />
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
            <div
              className="h-full rounded-full bg-white transition-[width] duration-75"
              style={{ width: `${Math.min(100, Math.round(level * 140))}%` }}
            />
          </div>
        </div>
      ) : null}

      {error ? (
        <p className="mt-2 text-[10px] leading-4 text-muted-foreground">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function ActiveCall({ call }: { call: ReturnType<typeof useCall> }) {
  const level = useLevel(call.localStream, call.muted);
  const videoRef = useRef<HTMLVideoElement>(null);
  const tiles = Object.entries(call.remoteStreams);

  // The local preview, so you can see what you are sending.
  useEffect(() => {
    if (videoRef.current && call.localStream) {
      videoRef.current.srcObject = call.localStream;
    }
  }, [call.localStream]);

  if (call.current?.incoming) {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-3 rounded-xl border border-border/60 bg-background/40 px-3 py-2.5">
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-white/10 text-white">
            {call.kind === "video" ? (
              <Video className="size-4" />
            ) : (
              <Phone className="size-4" />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[12px] font-medium">
              {call.current.startedByName}
            </p>
            <p className="truncate text-[10px] text-muted-foreground">
              {(call.current.people.length ?? 0) > 2
                ? "Conference call"
                : call.kind === "video"
                  ? "Video call"
                  : "Voice call"}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            type="button"
            onClick={call.answer}
            className="h-9 flex-1 rounded-xl bg-white text-[11px] text-black hover:bg-white/85"
          >
            <Phone className="size-3.5" />
            Answer
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={call.decline}
            className="h-9 flex-1 rounded-xl text-[11px]"
          >
            <PhoneOff className="size-3.5" />
            Decline
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {call.kind === "video" ? (
        <div className="grid grid-cols-2 gap-1.5">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className="aspect-video w-full rounded-xl border border-border/60 bg-black object-cover"
          />
          {tiles.map(([id, stream]) => (
            <RemoteVideo key={id} stream={stream} />
          ))}
        </div>
      ) : null}

      <div className="flex items-center gap-3 rounded-xl border border-border/60 bg-background/40 px-3 py-2.5">
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-white/10 text-white">
          {call.kind === "video" ? (
            <Video className="size-4" />
          ) : (
            <Phone className="size-4" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12px] font-medium">
            {call.current?.people
              .filter((one) => !one.isMe)
              .map((one) => one.name)
              .join(", ") || "Waiting for them to pick up"}
          </p>
          <p className="truncate text-[10px] text-muted-foreground">
            {call.problem
              ? call.problem
              : call.failure
                ? call.failure
                : call.state === "connecting"
                  ? "Connecting…"
                  : call.muted
                    ? "Your microphone is muted"
                    : "Your microphone is live"}
          </p>
        </div>
        {call.state === "connecting" ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        ) : null}
      </div>

      {/* Both the device and the network are recoverable: offer the retry. */}
      {call.problem ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={call.retryMedia}
          className="h-8 gap-1.5 rounded-xl text-[11px]"
        >
          <RotateCw className="size-3.5" />
          Try the camera again
        </Button>
      ) : call.failure ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={call.retryConnection}
          className="h-8 gap-1.5 rounded-xl text-[11px]"
        >
          <RotateCw className="size-3.5" />
          Retry the connection
        </Button>
      ) : null}

      {/* Live microphone level — flat while muted, moving while live. */}
      <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
        <div
          className="h-full rounded-full bg-white transition-[width] duration-75"
          style={{ width: `${Math.min(100, Math.round(level * 140))}%` }}
        />
      </div>

      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant={call.muted ? "default" : "outline"}
          size="sm"
          aria-pressed={call.muted}
          onClick={() => call.setMuted(!call.muted)}
          className="h-9 flex-1 gap-1.5 rounded-xl text-[11px]"
        >
          {call.muted ? (
            <MicOff className="size-3.5" />
          ) : (
            <Mic className="size-3.5" />
          )}
          {call.muted ? "Unmute" : "Mute"}
        </Button>

        <Button
          type="button"
          variant={call.speaker ? "default" : "outline"}
          size="sm"
          aria-pressed={call.speaker}
          title="Hear the other end"
          onClick={() => call.setSpeaker(!call.speaker)}
          className="h-9 flex-1 gap-1.5 rounded-xl text-[11px]"
        >
          {call.speaker ? "Speaker" : "Muted"}
        </Button>

        <Button
          type="button"
          size="sm"
          onClick={call.hangUp}
          className="h-9 flex-1 gap-1.5 rounded-xl bg-white text-[11px] text-black hover:bg-white/85"
        >
          <PhoneOff className="size-3.5" />
          End
        </Button>
      </div>
    </div>
  );
}

function RemoteVideo({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);

  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted
      className="aspect-video w-full rounded-xl border border-border/60 bg-black object-cover"
    />
  );
}
