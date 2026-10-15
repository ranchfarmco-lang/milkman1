import { useCallApi, useCallStage } from "@/components/CallProvider";
import { Button } from "@/components/ui/button";
import {
  callBoxSize,
  clampSpot,
  screenBoxSize,
  screenLabel,
  shareLine,
  startSpot,
  type Size,
  type Spot,
} from "@/lib/call-surfaces";
import { cn, initials } from "@/lib/utils";
import {
  Bell,
  Camera,
  CameraOff,
  ChevronDown,
  ChevronUp,
  Expand,
  GripHorizontal,
  Loader2,
  Mic,
  MicOff,
  MonitorUp,
  MonitorX,
  PhoneOff,
  RotateCw,
  ScreenShare,
  Users,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";

/**
 * The two windows a call can live in: the call itself, and the portal that
 * carries a shared screen.
 *
 * They are drawn here, at the level of the app shell, rather than inside the
 * Messenger page — and that is the whole point. A call is held by the shell, so
 * leaving the page must not take the picture with it: the boxes follow you onto
 * the calendar, into the assistant, through the browser, and keep showing who
 * is talking and what is on somebody's screen while you get on with something
 * else. Neither box is a dialog, either: they float over the page without
 * closing it, so the page underneath stays usable, and a tap on one of them
 * does not hang anything up.
 *
 * Both can be dragged by their title bar (the maths of where they may sit is in
 * `src/lib/call-surfaces.ts`, so it is checkable without a browser), and the
 * call can be put back into the Messenger page's own portals and taken out
 * again as often as you like. The bell in the call's own bar rings somebody
 * else into the call — the same list the Messenger opens — because a call that
 * cannot grow is a call somebody has to hang up and start again.
 *
 * Nothing in here touches the media: hanging up is the only thing that ends a
 * call.
 */

type LiveCall = NonNullable<ReturnType<typeof useCallStage>>;
type CallApi = ReturnType<typeof useCallApi>;

/** Where the window is, in pixels. */
function viewportSize(): Size {
  return { width: window.innerWidth, height: window.innerHeight };
}

/**
 * A window that can be put anywhere.
 *
 * Fixed boxes do not come with a way to move them, and the point of these is
 * that they can be shoved out of the way of whatever is actually being worked
 * on. The pointer capture is what keeps the drag alive when the pointer crosses
 * the video inside the box or leaves the window entirely.
 */
function useBoxSpot(
  ref: RefObject<HTMLDivElement | null>,
  sizeFor: (viewport: Size) => Size,
  index: number,
) {
  const [spot, setSpot] = useState<Spot | null>(null);
  const [viewport, setViewport] = useState(viewportSize);
  const from = useRef<{ x: number; y: number; left: number; top: number } | null>(
    null,
  );

  useEffect(() => {
    const onResize = () => setViewport(viewportSize());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const size = sizeFor(viewport);
  const placed = clampSpot(spot ?? startSpot(size, viewport, index), size, viewport);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    // A button in the bar is a button, not a handle.
    if ((event.target as HTMLElement).closest("button, a, input, select")) return;
    const element = ref.current;
    if (!element) return;

    const rect = element.getBoundingClientRect();
    from.current = {
      x: event.clientX,
      y: event.clientY,
      left: rect.left,
      top: rect.top,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [ref]);

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const start = from.current;
      const element = ref.current;
      if (!start || !element) return;

      const rect = element.getBoundingClientRect();
      setSpot(
        clampSpot(
          {
            left: start.left + (event.clientX - start.x),
            top: start.top + (event.clientY - start.y),
          },
          { width: rect.width, height: rect.height },
          viewportSize(),
        ),
      );
    },
    [ref],
  );

  const onPointerUp = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    from.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  return {
    style: {
      left: placed.left,
      top: placed.top,
      width: size.width,
      height: size.height,
    },
    handle: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
    },
  };
}

export function CallWindows() {
  const call = useCallStage();
  const api = useCallApi();

  if (!call) return null;

  const watching = api.screenOpen;

  return (
    <>
      {api.surface === "box" && call.current ? (
        <CallBox call={call} api={api} />
      ) : null}
      {watching ? (
        <ScreenPortal call={call} api={api} userId={watching} />
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------------ the call */

/** The call as a window: the faces, or the voices, and every control. */
function CallBox({ call, api }: { call: LiveCall; api: CallApi }) {
  const [collapsed, setCollapsed] = useState(false);
  const video = call.kind === "video";
  const boxRef = useRef<HTMLDivElement | null>(null);
  const box = useBoxSpot(boxRef, (viewport) => callBoxSize(call.kind, viewport, collapsed), 0);

  const people = (call.current?.people ?? []).filter(
    (one) => one.state === "joined",
  );
  const others = people.filter((one) => !one.isMe);
  const onCall = call.current?.myState === "joined";
  const shared = people.filter(
    (one) => !one.isMe && call.screens[one.userId] !== undefined,
  );

  return (
    <div
      ref={boxRef}
      style={box.style}
      className="fixed z-40 flex flex-col overflow-hidden rounded-2xl border border-border/70 bg-popover/95 shadow-2xl backdrop-blur"
    >
      <div
        {...box.handle}
        className="flex shrink-0 touch-none items-center gap-1.5 border-b border-border/60 px-2 py-1.5"
      >
        <GripHorizontal className="size-3.5 shrink-0 cursor-grab text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[11px] font-semibold">
            {video ? "Video" : "Voice"} call · {people.length} in
          </p>
          <p className="truncate text-[9px] text-muted-foreground">
            {call.state === "connected"
              ? "Live, and encrypted end to end."
              : "Bringing everyone in…"}
          </p>
        </div>

        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={collapsed ? "Show the call" : "Hide the picture"}
          title={collapsed ? "Show the call" : "Hide the picture — the call keeps going"}
          onClick={() => setCollapsed((was) => !was)}
          className="shrink-0 text-muted-foreground hover:text-foreground"
        >
          {collapsed ? (
            <ChevronUp className="size-3.5" />
          ) : (
            <ChevronDown className="size-3.5" />
          )}
        </Button>

        {/* The same list the Messenger's ring button opens, ringing people into
            this very call — the box follows you to other pages, and ringing
            somebody in has to be possible from there too. */}
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Ring someone into the call"
          title="Ring the others into this call — they are rung and notified, and nobody on it is dropped"
          disabled={!onCall}
          onClick={() => api.openPicker(call.kind)}
          className="shrink-0 text-muted-foreground hover:text-foreground"
        >
          <Bell className="size-3.5" />
        </Button>

        {api.canDock ? (
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Put the call back in the page"
            title="Put the call back in the Messenger's own portals"
            onClick={api.dock}
            className="shrink-0 text-muted-foreground hover:text-foreground"
          >
            <Users className="size-3.5" />
          </Button>
        ) : null}
      </div>

      {collapsed ? null : (
        <>
          {video ? (
            <div className="grid min-h-0 flex-1 auto-rows-[minmax(0,1fr)] grid-cols-2 gap-1.5 overflow-hidden p-1.5">
              {people.slice(0, 4).map((person) => (
                <BoxTile
                  key={person.userId}
                  name={person.isMe ? "You" : person.name}
                  stream={
                    person.isMe
                      ? call.localStream
                      : (call.remoteStreams[person.userId] ?? null)
                  }
                  micOff={person.isMe ? call.muted : false}
                  cameraOff={person.isMe ? !call.cameraOn : false}
                  sharing={call.screens[person.userId] !== undefined}
                />
              ))}
              {people.length === 0 ? (
                <div className="col-span-2 grid place-items-center text-[10px] text-muted-foreground">
                  Nobody else is on yet.
                </div>
              ) : null}
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto px-2.5 py-2">
              <p className="text-[10px] leading-4 text-muted-foreground">
                {others.length
                  ? `${others.map((one) => one.name).join(", ")} on the call.`
                  : "Waiting for the others to turn up."}
              </p>
            </div>
          )}

          {shared.length ? (
            <p className="shrink-0 px-2.5 pb-1 text-[9px] text-muted-foreground">
              {shared.map((one) => shareLine(one.name, false)).join(" · ")}
            </p>
          ) : null}

          <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-border/60 p-1.5">
            <Button
              type="button"
              variant={call.muted ? "default" : "outline"}
              size="sm"
              aria-pressed={call.muted}
              onClick={() => call.setMuted(!call.muted)}
              className="h-8 min-w-16 flex-1 gap-1.5 rounded-lg text-[10px]"
            >
              {call.muted ? (
                <MicOff className="size-3.5" />
              ) : (
                <Mic className="size-3.5" />
              )}
              {call.muted ? "Unmute" : "Mute"}
            </Button>

            {video ? (
              <Button
                type="button"
                variant={call.cameraOn ? "default" : "outline"}
                size="sm"
                aria-pressed={call.cameraOn}
                onClick={() => call.setCameraOn(!call.cameraOn)}
                className="h-8 min-w-16 flex-1 gap-1.5 rounded-lg text-[10px]"
              >
                {call.cameraOn ? (
                  <Camera className="size-3.5" />
                ) : (
                  <CameraOff className="size-3.5" />
                )}
                {call.cameraOn ? "Camera" : "Camera off"}
              </Button>
            ) : null}

            <Button
              type="button"
              variant={call.speaker ? "default" : "outline"}
              size="sm"
              aria-pressed={call.speaker}
              title="Hear the others"
              onClick={() => call.setSpeaker(!call.speaker)}
              className="h-8 min-w-16 flex-1 gap-1.5 rounded-lg text-[10px]"
            >
              {call.speaker ? (
                <Volume2 className="size-3.5" />
              ) : (
                <VolumeX className="size-3.5" />
              )}
              {call.speaker ? "Sound" : "Muted"}
            </Button>

            <Button
              type="button"
              variant={call.sharing ? "default" : "outline"}
              size="sm"
              aria-pressed={call.sharing}
              disabled={!onCall}
              title={
                onCall
                  ? "Share this device's screen — it opens in its own portal"
                  : "Get on the call first: a screen goes on the call"
              }
              onClick={() =>
                call.sharing ? call.stopShare() : call.shareScreen()
              }
              className="h-8 min-w-16 flex-1 gap-1.5 rounded-lg text-[10px]"
            >
              {call.sharing ? (
                <MonitorX className="size-3.5" />
              ) : (
                <MonitorUp className="size-3.5" />
              )}
              {call.sharing ? "Stop share" : "Share"}
            </Button>

            <Button
              type="button"
              size="sm"
              onClick={call.hangUp}
              className="h-8 min-w-16 flex-1 gap-1.5 rounded-lg bg-white text-[10px] text-black hover:bg-white/85"
            >
              <PhoneOff className="size-3.5" />
              Hang up
            </Button>
          </div>

          {call.shareProblem ? (
            <p className="shrink-0 border-t border-border/60 px-2.5 py-1.5 text-[9px] leading-4 text-muted-foreground">
              {call.shareProblem}
            </p>
          ) : null}

          {call.problem || call.failure ? (
            <div className="flex shrink-0 items-center gap-2 border-t border-border/60 px-2.5 py-1.5">
              <p className="min-w-0 flex-1 text-[9px] leading-4 text-foreground/80">
                {call.problem ?? call.failure}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={call.problem ? call.retryMedia : call.retryConnection}
                className="h-6 shrink-0 gap-1 rounded-lg text-[9px]"
              >
                <RotateCw className="size-2.5" />
                Try again
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

/** One face in the call window, with the same labels the room uses. */
function BoxTile({
  name,
  stream,
  micOff,
  cameraOff,
  sharing,
}: {
  name: string;
  stream: MediaStream | null;
  micOff: boolean;
  cameraOff: boolean;
  sharing: boolean;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (element && element.srcObject !== stream) element.srcObject = stream;
  }, [stream]);

  return (
    <div className="relative h-full min-h-0 w-full overflow-hidden rounded-xl border border-border/60 bg-black/85">
      {stream ? (
        <video
          ref={ref}
          autoPlay
          playsInline
          muted
          className={cn(
            "size-full object-cover transition-opacity",
            cameraOff && "opacity-0",
          )}
        />
      ) : null}

      {!stream ? (
        <div className="absolute inset-0 grid place-items-center gap-1.5">
          <Loader2 className="size-3.5 animate-spin text-white/40" />
          <span className="text-[9px] font-medium text-white/50">
            Connecting…
          </span>
        </div>
      ) : null}

      {!stream || cameraOff ? (
        <div className="absolute inset-0 grid place-items-center">
          <span className="grid size-8 place-items-center rounded-full bg-white/10 text-[11px] font-semibold text-white">
            {initials(name)}
          </span>
        </div>
      ) : null}

      <span className="absolute bottom-1 left-1 inline-flex max-w-[85%] items-center gap-1 rounded-md bg-black/65 px-1.5 py-0.5 text-[9px] font-medium text-white/90 backdrop-blur-sm">
        {micOff ? <MicOff className="size-2.5 shrink-0" /> : null}
        {sharing ? <ScreenShare className="size-2.5 shrink-0" /> : null}
        <span className="truncate">{name}</span>
      </span>
    </div>
  );
}

/* ----------------------------------------------------------- shared screens */

/**
 * A shared screen in a portal of its own.
 *
 * Deliberately not a seat in the grid and not a dialog over it: the people on
 * the call keep their places and keep talking while a screen is open beside
 * them, and the portal can be dragged anywhere on the page — over the calendar
 * it is being read from, next to the notes it is being written into, or made to
 * fill the screen. It closes without touching the call.
 */
function ScreenPortal({
  call,
  api,
  userId,
}: {
  call: LiveCall;
  api: CallApi;
  userId: string;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const box = useBoxSpot(boxRef, screenBoxSize, 1);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const stream = call.screens[userId] ?? null;
  const person = (call.current?.people ?? []).find(
    (one) => one.userId === userId,
  );
  const mine = userId === call.myId;
  const sharers = Object.keys(call.screens);

  useEffect(() => {
    const element = videoRef.current;
    if (element && element.srcObject !== stream) element.srcObject = stream;
  }, [stream]);

  const fill = useCallback(() => {
    const element = videoRef.current;
    if (!element) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void element.requestFullscreen().catch(() => undefined);
  }, []);

  return (
    <div
      ref={boxRef}
      style={box.style}
      className="fixed z-40 flex flex-col overflow-hidden rounded-2xl border border-border/70 bg-popover/95 shadow-2xl backdrop-blur"
    >
      <div
        {...box.handle}
        className="flex shrink-0 touch-none items-center gap-1.5 border-b border-border/60 px-2 py-1.5"
      >
        <ScreenShare className="size-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[11px] font-semibold">
            {screenLabel(person?.name, mine)}
          </p>
          <p className="truncate text-[9px] text-muted-foreground">
            {mine
              ? "You are sharing — the call carries on beside it."
              : "Their screen, in its own portal. The call carries on."}
          </p>
        </div>

        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label="Fill the screen with it"
          title="Fill this screen with it"
          onClick={fill}
          className="shrink-0 text-muted-foreground hover:text-foreground"
        >
          <Expand className="size-3.5" />
        </Button>

        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={mine ? "Stop sharing this screen" : "Stop watching"}
          title={mine ? "Stop sharing" : "Stop watching — the call keeps going"}
          onClick={() => (mine ? call.stopShare() : api.closeScreen())}
          className="shrink-0 text-muted-foreground hover:text-foreground"
        >
          {mine ? <MonitorX className="size-3.5" /> : <X className="size-3.5" />}
        </Button>
      </div>

      {/* Two screens on the call at once: pick either without hunting for the
          seat it belongs to. */}
      {sharers.length > 1 ? (
        <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border/60 px-2 py-1">
          {sharers.map((id) => {
            const who = (call.current?.people ?? []).find(
              (one) => one.userId === id,
            );
            return (
              <Button
                key={id}
                type="button"
                size="sm"
                variant={id === userId ? "default" : "ghost"}
                onClick={() => api.openScreen(id)}
                className="h-6 shrink-0 rounded-lg px-2 text-[9px]"
              >
                {id === call.myId ? "Yours" : (who?.name ?? "Theirs")}
              </Button>
            );
          })}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 bg-black/85">
        {stream ? (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className="size-full object-contain"
          />
        ) : (
          <div className="grid size-full place-items-center px-4 text-center text-[10px] leading-4 text-white/70">
            That screen has stopped. The call is still going.
          </div>
        )}
      </div>
    </div>
  );
}
