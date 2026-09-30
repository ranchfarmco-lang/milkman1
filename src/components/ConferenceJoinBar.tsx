import { useCallStage } from "@/components/CallProvider";
import { Button } from "@/components/ui/button";
import { PhoneOff, Video } from "lucide-react";

/**
 * A conference ringing at you, answered right where you are: who is calling,
 * and a Join button. It sits inside the messenger's video room, so a call can be
 * picked up without leaving the page.
 */
export function ConferenceJoinBar({
  call,
}: {
  call: NonNullable<ReturnType<typeof useCallStage>>;
}) {
  const caller = call.current?.startedByName ?? "Someone";
  const invited = call.current?.people.length ?? 0;

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 rounded-2xl border border-white/20 bg-white/10 px-3 py-2 backdrop-blur-sm">
      <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-white/15 text-white">
        <Video className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[11px] font-semibold">
          {caller} is calling
        </p>
        <p className="truncate text-[9px] text-muted-foreground">
          {invited} on the call · join to see them
        </p>
      </div>
      <Button
        type="button"
        size="sm"
        onClick={call.answer}
        className="h-8 gap-1.5 rounded-lg bg-white text-[10px] text-black hover:bg-white/85"
      >
        <Video className="size-3.5" />
        Join
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={call.decline}
        className="h-8 gap-1.5 rounded-lg text-[10px]"
      >
        <PhoneOff className="size-3.5" />
        Decline
      </Button>
    </div>
  );
}
