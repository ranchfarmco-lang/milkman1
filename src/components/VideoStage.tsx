import { useCallApi, useCallStage } from "@/components/CallProvider";
import { Button } from "@/components/ui/button";
import { ringLine } from "@/lib/call-surfaces";
import { cn, initials } from "@/lib/utils";
import {
  Bell,
  Camera,
  CameraOff,
  Loader2,
  Mic,
  MicOff,
  MonitorUp,
  MonitorX,
  PhoneOff,
  PictureInPicture2,
  RotateCw,
  ScreenShare,
  Video,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useEffect, useRef } from "react";

type LiveCall = NonNullable<ReturnType<typeof useCallStage>>;
type CallApi = ReturnType<typeof useCallApi>;

/**
 * A four-way video call, drawn as four portals in a two-by-two grid: the two
 * top seats and the two bottom seats. Everyone negotiates their own connection
 * straight to everyone else, so with four people each device holds three links
 * and no media ever passes through the server.
 */
const PORTALS = 4;

/**
 * The stage shows itself only for a video call you are actually in, and only
 * while the call is the page's to draw. A call still ringing at you is answered
 * in the panel, a voice call lives in the movable box, and a call taken out of
 * the page — `In a box` below — leaves the room behind until it is put back.
 */
export function VideoStage({ className }: { className?: string }) {
  const call = useCallStage();
  const api = useCallApi();

  if (
    !call ||
    !call.current ||
    call.kind !== "video" ||
    call.current.myState !== "joined" ||
    api.surface !== "page"
  ) {
    return null;
  }

  return <StageBody call={call} api={api} className={className} />;
}

function StageBody({
  call,
  api,
  className,
}: {
  call: LiveCall;
  api: CallApi;
  className?: string;
}) {
  // Everyone on the call, and everyone it is ringing: somebody who has been
  // rung is part of what is happening and belongs in the grid, saying so. A
  // blank seat where a person is being rung is how a call "does nothing" when
  // it is in fact ringing the house.
  const people = (call.current?.people ?? []).filter(
    (one) => one.state === "joined" || one.state === "ringing",
  );
  const me = people.find((one) => one.isMe) ?? null;
  const others = people.filter((one) => !one.isMe);
  const inCall = people.filter((one) => one.state === "joined");
  const ringing = people.filter((one) => one.state === "ringing");

  // Me first, then everyone else who is in or being rung — four portals at most.
  const seats = [me, ...others]
    .filter((one): one is (typeof people)[number] => one !== null)
    .slice(0, PORTALS);
  const openSeats = Math.max(0, PORTALS - seats.length);

  return (
    <section
      className={cn(
        "flex h-full min-h-0 flex-col rounded-2xl border border-border/70 bg-card/70 p-2.5 backdrop-blur-sm",
        className,
      )}
    >
      <div className="mb-2 flex shrink-0 items-center gap-2 px-0.5">
        <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-white/10 text-white">
          <Video className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[11px] font-semibold">
            {inCall.length} of {PORTALS} in the video call
          </p>
          <p className="truncate text-[9px] text-muted-foreground">
            {/* Who has been rung is said out loud: it is the only sign that the
                ring went anywhere. */}
            {ringing.length
              ? ringLine(ringing.map((one) => one.name))
              : call.state === "connected"
                ? "Live, and encrypted end to end."
                : "Bringing everyone in…"}
          </p>
        </div>
        {call.state === "connecting" && call.transport === "pending" ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        ) : (
          // Say which way the media is travelling, so it is never a mystery
          // whether a relay is carrying the call or the devices are direct.
          <span
            title={
              call.transport === "livekit"
                ? "Carried by the media server, so it works from any two networks"
                : "Directly between the devices — no server in the middle"
            }
            className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border/60 bg-background/40 px-2 py-0.5 text-[9px] font-medium text-muted-foreground"
          >
            {call.transport === "livekit"
              ? "Media server"
              : call.transport === "p2p"
                ? "Direct"
                : "Starting…"}
          </span>
        )}

        {/* The call does not have to live on this page. Taken out of it, the
            same seats and the same sound carry on in a box that follows you to
            the calendar, the assistant and the browser. */}
        <Button
          type="button"
          variant="outline"
          size="sm"
          title="Take the call out of the page — it follows you to every other tab"
          onClick={api.popOut}
          className="h-7 shrink-0 gap-1.5 rounded-lg text-[9px]"
        >
          <PictureInPicture2 className="size-3" />
          In a box
        </Button>
      </div>

      {/* Four seats in the four corners: half the width and half the height
          each, so the grid splits evenly both ways however big it gets. */}
      <div className="grid min-h-0 flex-1 grid-cols-2 grid-rows-2 gap-2">
        {seats.map((person) => (
          <Portal
            key={person.userId}
            name={person.isMe ? "You" : person.name}
            stream={
              person.isMe
                ? call.localStream
                : (call.remoteStreams[person.userId] ?? null)
            }
            micOff={person.isMe ? call.muted : false}
            cameraOff={person.isMe ? !call.cameraOn : false}
            connecting={!person.isMe && !call.remoteStreams[person.userId]}
            ringing={person.state === "ringing"}
            // The option sits in each person's own box: mine shares, theirs is
            // watched — in a portal of its own, without touching the call.
            sharing={call.screens[person.userId] !== undefined}
            mine={person.isMe}
            onShareScreen={() =>
              call.sharing ? call.stopShare() : call.shareScreen()
            }
            onWatchScreen={() => api.openScreen(person.userId)}
          />
        ))}
        {Array.from({ length: openSeats }).map((_, index) => (
          <EmptySeat
            key={`seat-${index}`}
            // An empty seat is the one place the call can be opened wider from,
            // right where the missing faces would be.
            onRing={() => api.openPicker(call.kind)}
          />
        ))}
      </div>

      {/* The controls wrap rather than sit in one unbreakable row. Four
          buttons whose labels cannot break are wider than a small phone, and
          the row was the thing pushing the whole page sideways on one. */}
      <div className="mt-2 flex shrink-0 flex-wrap items-center gap-1.5">
        <Button
          type="button"
          variant={call.muted ? "default" : "outline"}
          size="sm"
          aria-pressed={call.muted}
          onClick={() => call.setMuted(!call.muted)}
          className="h-8 flex-1 gap-1.5 rounded-lg text-[10px]"
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
          variant={call.cameraOn ? "default" : "outline"}
          size="sm"
          aria-pressed={call.cameraOn}
          onClick={() => call.setCameraOn(!call.cameraOn)}
          className="h-8 flex-1 gap-1.5 rounded-lg text-[10px]"
        >
          {call.cameraOn ? (
            <Camera className="size-3.5" />
          ) : (
            <CameraOff className="size-3.5" />
          )}
          {call.cameraOn ? "Camera" : "Camera off"}
        </Button>

        <Button
          type="button"
          variant={call.speaker ? "default" : "outline"}
          size="sm"
          aria-pressed={call.speaker}
          title="Hear the others"
          onClick={() => call.setSpeaker(!call.speaker)}
          className="h-8 flex-1 gap-1.5 rounded-lg text-[10px]"
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
          title="Share this device's screen — it opens in a portal of its own"
          onClick={() =>
            call.sharing ? call.stopShare() : call.shareScreen()
          }
          className="h-8 flex-1 gap-1.5 rounded-lg text-[10px]"
        >
          {call.sharing ? (
            <MonitorX className="size-3.5" />
          ) : (
            <MonitorUp className="size-3.5" />
          )}
          {call.sharing ? "Stop share" : "Share screen"}
        </Button>

        <Button
          type="button"
          size="sm"
          onClick={call.hangUp}
          className="h-8 flex-1 gap-1.5 rounded-lg bg-white text-[10px] text-black hover:bg-white/85"
        >
          <PhoneOff className="size-3.5" />
          Leave
        </Button>
      </div>

      {call.shareProblem ? (
        <p className="mt-2 rounded-lg border border-white/15 bg-white/10 px-2.5 py-1.5 text-[10px] leading-4 text-foreground/80">
          {call.shareProblem}
        </p>
      ) : null}

      {call.problem || call.failure ? (
        <div className="mt-2 flex items-center gap-2 rounded-lg border border-white/15 bg-white/10 px-2.5 py-1.5">
          <p className="min-w-0 flex-1 text-[10px] leading-4 text-foreground/80">
            {call.problem ?? call.failure}
          </p>
          {call.problem || call.failure ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={call.problem ? call.retryMedia : call.retryConnection}
              className="h-7 shrink-0 gap-1.5 rounded-lg text-[10px]"
            >
              <RotateCw className="size-3" />
              Try again
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/**
 * One seat: a face, a name, whether their microphone is open — and their own
 * screen-share option. Mine shares; somebody else's, once it is on, is watched
 * in its portal. Either way the seat stays a seat: a screen never takes one
 * over, and no face is pushed out by one.
 */
function Portal({
  name,
  stream,
  micOff,
  cameraOff,
  connecting,
  ringing,
  sharing,
  mine,
  onShareScreen,
  onWatchScreen,
}: {
  name: string;
  stream: MediaStream | null;
  micOff: boolean;
  cameraOff: boolean;
  connecting: boolean;
  ringing: boolean;
  sharing: boolean;
  mine: boolean;
  onShareScreen: () => void;
  onWatchScreen: () => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (element && element.srcObject !== stream) element.srcObject = stream;
  }, [stream]);

  return (
    <div className="relative h-full min-h-0 w-full overflow-hidden rounded-xl border border-border/60 bg-black/85">
      {mine || sharing ? (
        <Button
          type="button"
          size="sm"
          variant={sharing ? "default" : "outline"}
          aria-pressed={mine ? sharing : undefined}
          title={
            mine
              ? sharing
                ? "Stop sharing this device's screen"
                : "Share this device's screen — it opens in a portal of its own"
              : "Open their screen in its own portal — the call carries on"
          }
          onClick={mine ? onShareScreen : onWatchScreen}
          className={cn(
            "absolute right-1.5 top-1.5 z-10 h-6 gap-1 rounded-md px-1.5 text-[9px]",
            sharing
              ? "bg-white text-black hover:bg-white/85"
              : "border-white/25 bg-black/60 text-white/90 hover:bg-black/75",
          )}
        >
          {mine && !sharing ? (
            <ScreenShare className="size-2.5" />
          ) : sharing ? (
            <MonitorX className="size-2.5" />
          ) : (
            <ScreenShare className="size-2.5" />
          )}
          {mine ? (sharing ? "Stop" : "Share") : "Watch"}
        </Button>
      ) : null}
      {stream ? (
        // Always muted: the sound is played by the call itself, so a face is
        // never heard twice.
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

      {!stream && ringing ? (
        <div className="absolute inset-0 grid place-items-center gap-1.5">
          <Bell className="size-4 animate-pulse text-white/50" />
          <span className="text-[9px] font-medium text-white/60">
            Ringing…
          </span>
        </div>
      ) : null}

      {!stream && connecting && !ringing ? (
        <div className="absolute inset-0 grid place-items-center gap-1.5">
          <Loader2 className="size-4 animate-spin text-white/40" />
          <span className="text-[9px] font-medium text-white/50">
            Connecting…
          </span>
        </div>
      ) : null}

      {(!stream && !connecting) || cameraOff ? (
        <div className="absolute inset-0 grid place-items-center">
          <span className="grid size-10 place-items-center rounded-full bg-white/10 text-[13px] font-semibold text-white">
            {initials(name)}
          </span>
        </div>
      ) : null}

      <span className="absolute bottom-1.5 left-1.5 inline-flex max-w-[80%] items-center gap-1 rounded-md bg-black/65 px-1.5 py-0.5 text-[9px] font-medium text-white/90 backdrop-blur-sm">
        {micOff ? <MicOff className="size-2.5 shrink-0" /> : null}
        <span className="truncate">{name}</span>
      </span>
    </div>
  );
}

/** A seat nobody has taken yet — and the way to fill it. */
function EmptySeat({ onRing }: { onRing: () => void }) {
  return (
    <button
      type="button"
      onClick={onRing}
      title="Ring someone into the call — they are rung and notified"
      className="grid h-full min-h-0 w-full cursor-pointer place-items-center overflow-hidden rounded-xl border border-dashed border-border/70 bg-background/30 transition-colors hover:border-border hover:bg-accent/20"
    >
      <span className="flex flex-col items-center gap-1 text-muted-foreground">
        <Bell className="size-4" />
        <span className="text-[9px] font-medium">Ring someone</span>
        <span className="text-[8px]">they are notified straight away</span>
      </span>
    </button>
  );
}
