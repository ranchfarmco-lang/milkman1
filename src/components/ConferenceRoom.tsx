import { useCallApi, useCallStage } from "@/components/CallProvider";
import { ConferenceJoinBar } from "@/components/ConferenceJoinBar";
import { VideoStage } from "@/components/VideoStage";
import { Button } from "@/components/ui/button";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { FamilyMember } from "@/convex/family";
import { cn, initials } from "@/lib/utils";
import { useMutation, useQuery } from "convex/react";
import { Trash2, Video } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

/**
 * The family's standing video room, living on the Messenger page beside the
 * transcript.
 *
 * Four portals are always up. Each one holds a person with their name and
 * whether they are online; their video button gets them into the call, and the
 * moment a video call is live those same four portals fill with faces. An open
 * portal is where you get on yourself, so joining always lives in the grid.
 *
 * Everyone in the family is on the roster, online or away, so the seats show
 * who is here and who is not. Anyone shown can be removed with the button in
 * the corner of their portal.
 */
const SEATS = 4;

export function ConferenceRoom() {
  const family = useQuery(api.family.mine);
  const call = useCallStage();
  const { joinRoom } = useCallApi();
  const removeMember = useMutation(api.family.removeMember);

  const members = family?.members ?? [];
  const me = members.find((member) => member.isMe) ?? null;
  const others = members.filter((member) => !member.isMe);
  // How many people are on right now — you included, since you are here.
  const onlineCount = members.filter((member) => member.online).length;
  // Whoever is around first, so the seats are the faces you can actually reach.
  const seats = [...others]
    .sort((a, b) => {
      if (a.online !== b.online) return a.online ? -1 : 1;
      return a.name.localeCompare(b.name);
    })
    .slice(0, SEATS);
  const openSeats = Math.max(0, SEATS - seats.length);

  const remove = (member: FamilyMember) => {
    void removeMember({ userId: member._id as Id<"users"> })
      .then(() => toast.success(`${member.name} was removed from the family.`))
      .catch(() => toast.error("Could not remove that contact."));
  };

  // A conference ringing at you is answered right here, in the room.
  if (call?.current?.incoming) {
    return (
      <div className="flex h-full min-h-0 flex-col justify-center gap-3">
        <ConferenceJoinBar call={call} />
      </div>
    );
  }

  // Live: the same four portals, now full of faces and controls.
  if (call?.kind === "video" && call.current?.myState === "joined") {
    return <VideoStage className="flex-1" />;
  }

  return (
    <section className="flex h-full min-h-0 flex-col gap-2.5">
      <p className="shrink-0 px-0.5 text-[11px] font-medium text-muted-foreground">
        {onlineCount} online
      </p>

      <div className="grid min-h-0 flex-1 grid-cols-2 grid-rows-2 gap-3">
        {seats.map((member) => (
          <ContactSeat
            key={member._id}
            member={member}
            onJoin={joinRoom}
            onRemove={() => remove(member)}
          />
        ))}
        {Array.from({ length: openSeats }).map((_, index) => (
          <JoinSeat key={`open-${index}`} onJoin={joinRoom} />
        ))}
      </div>

      {me && others.length === 0 ? (
        <p className="shrink-0 rounded-xl border border-dashed border-border/70 px-3 py-2 text-center text-[10px] leading-4 text-muted-foreground">
          Nobody else is here yet. When someone joins, they show up in these
          boxes.
        </p>
      ) : null}
    </section>
  );
}

/** One portal: a person, whether they are around, their call and remove buttons. */
function ContactSeat({
  member,
  onJoin,
  onRemove,
}: {
  member: FamilyMember;
  onJoin: () => void;
  onRemove: () => void;
}) {
  const [confirming, setConfirming] = useState(false);

  return (
    <div
      className={cn(
        "relative flex h-full min-h-0 flex-col items-center justify-center gap-2.5 overflow-hidden rounded-2xl border border-border/70 bg-card/60 p-3 text-center",
        !member.online && "opacity-70",
      )}
    >
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label={`Remove ${member.name}`}
        title={`Remove ${member.name}`}
        onClick={() => setConfirming(true)}
        className="absolute right-2 top-2 text-muted-foreground hover:text-foreground"
      >
        <Trash2 className="size-3.5" />
      </Button>

      <span className="grid size-14 shrink-0 place-items-center rounded-full border border-border/60 bg-white/10 text-[18px] font-semibold text-white">
        {initials(member.name)}
      </span>

      <p className="max-w-full truncate text-[12px] font-medium">
        {member.name}
      </p>

      <span
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[9px] font-medium",
          member.online
            ? "border-white/25 bg-white/10 text-foreground"
            : "border-border/60 text-muted-foreground",
        )}
      >
        <span
          className={cn(
            "size-1.5 rounded-full",
            member.online ? "bg-white" : "bg-muted-foreground/40",
          )}
        />
        {member.online ? "Online" : "Offline"}
      </span>

      <Button
        type="button"
        size="sm"
        onClick={onJoin}
        className="mt-0.5 h-8 gap-1.5 rounded-lg bg-white text-[10px] text-black hover:bg-white/85"
      >
        <Video className="size-3.5" />
        Get on
      </Button>

      {confirming ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background/90 p-3 text-center backdrop-blur-sm">
          <p className="text-[11px] font-semibold">Remove {member.name}?</p>
          <p className="max-w-[26ch] text-[9px] leading-4 text-muted-foreground">
            They come off the contacts and lose the messenger. They rejoin the
            same way anyone does — by signing in and being named.
          </p>
          <div className="mt-0.5 flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              onClick={onRemove}
              className="h-7 gap-1.5 rounded-lg bg-white text-[10px] text-black hover:bg-white/85"
            >
              <Trash2 className="size-3" />
              Remove
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setConfirming(false)}
              className="h-7 rounded-lg text-[10px]"
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** An open portal: where you get on the call and wait for the rest. */
function JoinSeat({ onJoin }: { onJoin: () => void }) {
  return (
    <div className="grid h-full min-h-0 place-items-center rounded-2xl border border-dashed border-border/70 bg-background/30 p-3">
      <Button
        type="button"
        size="sm"
        onClick={onJoin}
        className="h-8 gap-1.5 rounded-lg bg-white text-[10px] text-black hover:bg-white/85"
      >
        <Video className="size-3.5" />
        Get on the call
      </Button>
    </div>
  );
}
