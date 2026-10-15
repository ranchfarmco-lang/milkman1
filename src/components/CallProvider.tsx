import { CallWindows } from "@/components/CallWindows";
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
import {
  callPanel,
  callSurface,
  notYetOn,
  onCall,
  ringLine,
  type CallSurface,
} from "@/lib/call-surfaces";
import { cn } from "@/lib/utils";
import { useQuery } from "convex/react";
import { Bell, Camera, Loader2, Phone, PhoneOff, Video } from "lucide-react";
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
import { toast } from "sonner";

/**
 * Calling: our own video boxes, drawn by our own code.
 *
 * The four-portal grid, the ring, the handshake (carried by our own Convex
 * backend) and the media engine are all ours — nothing here is a third-party
 * widget. The media itself is encrypted end to end, either straight between the
 * devices or through a media server that every device connects out to (see
 * `use-call.ts`), which is what makes it work from behind a strict router.
 *
 * This provider is deliberately the *shell's*, not a page's, and the live call
 * is held here for one reason above all: leaving the Messenger must not drop a
 * call. The media, the shared screens and the call itself stay put while pages
 * come and go underneath them — a call ends when somebody hangs up, and at no
 * other time.
 *
 * Three separate things are drawn, and keeping them apart is what makes the
 * page usable during a call:
 *
 *   1. **the portals**, on the Messenger itself, when a video call is on and
 *      nobody has taken it out of the page;
 *   2. **the movable call box**, everywhere else (`CallWindows.tsx`) — it
 *      follows you across the hub and can be dragged out of the way;
 *   3. **the panel**, a dialog that is only ever a ring to answer or the list of
 *      who to call. It closes without touching a call that is already up.
 *
 * The list of who to call is also how the others are **rung into a call that is
 * already going on**. Ringing from scratch opens a new call and ends whatever
 * you were in; that is the wrong thing mid-conversation, so with a call up the
 * same list rings people into it instead — see `calls.invite`. Either way the
 * person at the other end is rung the same way: a panel they answer, a ringtone
 * and a notification, so a call is never something they find out about later.
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
  /** Where the live call is drawn: the page's portals, a movable box, nowhere. */
  surface: CallSurface;
  /** Take the call out of the page, into its own movable box. */
  popOut: () => void;
  /** Put it back among the Messenger's own portals. */
  dock: () => void;
  /** True while the page in front of you could hold the call itself. */
  canDock: boolean;
  /** Whose shared screen is open in its portal, if any. */
  screenOpen: string | null;
  openScreen: (userId: string) => void;
  closeScreen: () => void;
};

const CallContext = createContext<CallApi>({
  openPicker: () => undefined,
  ringOne: () => undefined,
  ringEveryone: () => undefined,
  joinRoom: () => undefined,
  surface: "none",
  popOut: () => undefined,
  dock: () => undefined,
  canDock: false,
  screenOpen: null,
  openScreen: () => undefined,
  closeScreen: () => undefined,
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
  /**
   * True once the call has been asked out of the Messenger's portals. Kept here
   * rather than on the page, because the page comes and goes and the call does
   * not: walking off the Messenger must not put the picture back in it.
   */
  const [poppedOut, setPoppedOut] = useState(false);
  /**
   * Which shared screen the portal is showing, and the set of screens it was
   * chosen among. A choice only holds while those screens are the same: the
   * moment somebody else puts a screen on, theirs opens — being seen is the
   * whole point of turning one on — while a chosen one is never interrupted.
   */
  const [screenPick, setScreenPick] = useState<{
    key: string;
    id: string | null;
  }>({ key: "", id: null });

  const openPicker = useCallback((kind: CallKind) => setPicker(kind), []);
  const popOut = useCallback(() => setPoppedOut(true), []);
  const dock = useCallback(() => setPoppedOut(false), []);

  const others = members.filter((member) => !member.isMe);
  const onlineOthers = others.filter((member) => member.online).length;

  // Ringing out says so, by name, the moment it goes: a ring that vanishes into
  // nothing is the one thing a caller cannot tell from a broken hub.
  const ringOne = useCallback(
    (kind: CallKind, userId: string) => {
      setPicker(null);
      const who = others.find((member) => member._id === userId)?.name ?? null;
      void call
        .ring(kind, [userId])
        .then(() => toast.success(ringLine([who]) ?? "Ringing them…"))
        .catch(() => toast.error("The ring could not be sent."));
    },
    [call, others],
  );

  // Ring the whole family at once — but only the people who are here. Ringing
  // someone who is not around just leaves a call hanging until the ring times
  // out, so the offline rows are left alone.
  const ringEveryone = useCallback(
    (kind: CallKind) => {
      setPicker(null);
      const here = others.filter((member) => member.online);
      void call
        .ring(
          kind,
          here.map((member) => member._id),
        )
        .then(() =>
          toast.success(
            ringLine(here.map((member) => member.name)) ??
              "Nobody is around to ring.",
          ),
        )
        .catch(() => toast.error("The ring could not be sent."));
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

  // Where the call is drawn, and what the panel is for. Both are pure decisions
  // (`src/lib/call-surfaces.ts`) rather than conditions worked out here: a video
  // call on the Messenger lives in the page's own portals, everything else in
  // the movable box, and on the Messenger a video ring is answered in the room.
  const onMessenger = location.pathname === "/messenger";
  const joined = call.current?.myState === "joined";
  /** The call's own people: on it, or being rung. */
  const people = call.current?.people ?? [];
  /** With a call up, the picker rings people into it instead of starting one. */
  const ringingInto = inCall && joined;
  const surface = callSurface({
    inCall,
    kind: call.kind,
    onMessenger,
    poppedOut,
  });
  const ringInRoom = incoming && call.kind === "video" && onMessenger;
  const panel = callPanel({ incoming, picker: picker !== null, ringInRoom });
  /** The page in front of you could hold a video call itself, put back. */
  const canDock = onMessenger && call.kind === "video" && joined;

  /**
   * Which shared screen the portal shows: the one that was chosen, the first
   * one on when nothing was, or none. A screen that starts while a choice is
   * standing opens its own portal, because being seen is the point of it.
   */
  const sharers = Object.keys(call.screens);
  const sharerKey = sharers.join(",");
  const screenOpen =
    sharers.length === 0
      ? null
      : screenPick.key === sharerKey
        ? screenPick.id
        : sharers[0];

  /**
   * Ring people into the call that is already up. Somebody already on the call,
   * or already being rung, is kept on the list but out of reach, so no button
   * quietly does nothing — and what actually went out is said out loud, by name.
   */
  const ringInto = (ids: string[]) => {
    setPicker(null);
    const fresh = notYetOn(people, ids);
    if (fresh.length === 0) {
      toast("Everyone asked for is already on the call.");
      return;
    }

    const names = fresh.map(
      (id) => others.find((member) => member._id === id)?.name ?? null,
    );
    void call
      .invite(fresh)
      .then((invited) => {
        if (invited > 0) {
          toast.success(ringLine(names) ?? "Ringing them…");
          return;
        }
        toast.error("Nobody could be rung — a call holds four people at once.");
      })
      .catch(() => toast.error("The ring could not be sent."));
  };

  const openScreen = useCallback(
    (userId: string) => setScreenPick({ key: sharerKey, id: userId }),
    [sharerKey],
  );
  const closeScreen = useCallback(
    () => setScreenPick({ key: sharerKey, id: null }),
    [sharerKey],
  );

  // Closing the panel means the picker was dismissed, or a ring was turned
  // down. It never means hanging up: the box, the portals and the hang-up button
  // are the only things that end a call.
  const close = () => {
    setPicker(null);
    if (incoming) call.decline();
  };

  return (
    <CallContext.Provider
      value={{
        openPicker,
        ringOne,
        ringEveryone,
        joinRoom,
        surface,
        popOut,
        dock,
        canDock,
        screenOpen,
        openScreen,
        closeScreen,
      }}
    >
      <CallStageContext.Provider value={call}>
        {children}

        {/* The call itself, when the page in front of you is not the one it
            belongs on. Drawn at the shell, so walking to another tab leaves it
            running — the picture, the sound and any shared screen come along. */}
        <CallWindows />

        {/* A ring to answer, or the list of who to call. Never the live call:
            that is the portals or the box, and closing this drops nothing. */}
        <Dialog
          open={panel !== "none"}
          onOpenChange={(next) => (next ? undefined : close())}
        >
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="text-[13px]">
                {title(call, picker, ringingInto)}
              </DialogTitle>
              <DialogDescription className="text-[11px] leading-4">
                {subtitle(call, picker, ringingInto)}
              </DialogDescription>
            </DialogHeader>

            {panel === "incoming" ? (
              <IncomingCall call={call} />
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
                          name={ringingInto ? "Everyone else" : "Everyone"}
                          detail={
                            ringingInto
                              ? `${notYetOn(people, others.map((one) => one._id)).length} not on the call yet`
                              : `${others.length} in the family · ${onlineOthers} online`
                          }
                          icon={
                            ringingInto ? (
                              <Bell className="size-3.5" />
                            ) : (
                              <Video className="size-3.5" />
                            )
                          }
                          onClick={() =>
                            ringingInto
                              ? ringInto(others.map((one) => one._id))
                              : ringEveryone(picker ?? "audio")
                          }
                        />
                      </li>
                      {others.map((member) => {
                        const where = ringingInto
                          ? onCall(people, member._id)
                          : "none";
                        return (
                          <li key={member._id}>
                            <PickerRow
                              name={member.name}
                              detail={
                                where === "joined"
                                  ? "On the call"
                                  : where === "ringing"
                                    ? "Ringing…"
                                    : member.online
                                      ? "Online"
                                      : "Offline"
                              }
                              dim={where !== "none" || !member.online}
                              disabled={where !== "none"}
                              icon={
                                ringingInto ? (
                                  <Bell className="size-3.5" />
                                ) : (
                                  <Phone className="size-3.5" />
                                )
                              }
                              onClick={() =>
                                ringingInto
                                  ? ringInto([member._id])
                                  : picker && ringOne(picker, member._id)
                              }
                            />
                          </li>
                        );
                      })}
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
  ringingInto: boolean,
) {
  if (call.current?.incoming) {
    const many = (call.current.people.length ?? 0) > 2;
    return `Incoming ${many ? "conference " : ""}${call.kind} call`;
  }
  if (ringingInto) return "Ring someone into this call";
  return picker === "video" ? "Start a video call" : "Start a voice call";
}

function subtitle(
  call: ReturnType<typeof useCall>,
  picker: CallKind | null,
  ringingInto: boolean,
) {
  if (call.current?.incoming) {
    return `${call.current.startedByName} is calling. A call happens alongside the room — everyone stays in the one thread.`;
  }
  if (ringingInto) {
    return "They are rung and notified straight away, and answering puts them into the call that is already going on. Nobody already on it is dropped.";
  }
  // The picker says the same thing for both kinds: what is being chosen is who
  // to call, and where the call will be drawn is not their decision.
  void picker;
  return "Pick who to call. Everyone is still in the same message room, and the call stays with you wherever you go.";
}

function PickerRow({
  name,
  detail,
  icon,
  dim = false,
  disabled = false,
  onClick,
}: {
  name: string;
  detail: string;
  icon: ReactNode;
  dim?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left transition-colors",
        disabled ? "cursor-default opacity-70" : "hover:bg-accent/40",
      )}
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

/**
 * A call ringing at you: who it is, and the two answers.
 *
 * The only live-call-shaped thing left in the panel, deliberately. Everything
 * that happens after this — the faces, the mute buttons, the shared screens —
 * belongs to the call itself, which lives in the portals or in the box and keeps
 * living when this dialog is long gone.
 */
function IncomingCall({ call }: { call: ReturnType<typeof useCall> }) {
  const ringing = call.current;
  if (!ringing) return null;

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
            {ringing.startedByName}
          </p>
          <p className="truncate text-[10px] text-muted-foreground">
            {ringing.people.length > 2
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