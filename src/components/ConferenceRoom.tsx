import { useCallApi, useCallStage } from "@/components/CallProvider";
import { ConferenceJoinBar } from "@/components/ConferenceJoinBar";
import { VideoStage } from "@/components/VideoStage";
import { Button } from "@/components/ui/button";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { FamilyMember } from "@/convex/family";
import { cn, initials } from "@/lib/utils";
import { useMutation, useQuery } from "convex/react";
import {
  Bell,
  Phone,
  PhoneOff,
  PictureInPicture2,
  Trash2,
  Users,
  Video,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

type LiveCall = NonNullable<ReturnType<typeof useCallStage>>;

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
 * the corner of their portal, and anyone shown can be **rung** — a bell in the
 * other corner, which tells that person there is a call rather than waiting for
 * them to notice the room. It is the same ring a phone makes: their hub rings,
 * notifies them and offers the call, wherever they are in the app.
 *
 * Two call states belong here rather than in a panel, because both are about
 * *this* account and *this* page: a call the tab is in but which has been taken
 * out of the page (drawn as a note and a button to put it back), and a call the
 * account is still on but this tab never joined — the membership a closed tab
 * or a second device left behind, offered back as a line rather than a panel
 * over whatever page is open.
 */
const SEATS = 4;

export function ConferenceRoom() {
  const family = useQuery(api.family.mine);
  const call = useCallStage();
  const { joinRoom, surface, dock, ringOne } = useCallApi();
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

  const onCall = call?.current?.myState === "joined";
  const videoCall = call?.kind === "video";

  // Live, and this page's to draw: the same four portals, now full of faces.
  if (call && onCall && videoCall && surface === "page") {
    return <VideoStage className="flex-1" />;
  }

  // Live, but taken out of the page: say where it went, and offer it back.
  if (call && onCall && videoCall && surface === "box") {
    return (
      <section className="flex h-full min-h-0 flex-col gap-2.5">
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 rounded-2xl border border-border/70 bg-card/60 p-4 text-center">
          <span className="grid size-10 place-items-center rounded-xl bg-white/10 text-white">
            <PictureInPicture2 className="size-4" />
          </span>
          <p className="text-[12px] font-semibold">You are on the call</p>
          <p className="max-w-[36ch] text-[10px] leading-4 text-muted-foreground">
            It is in its own box now, and it stays with you while you move around
            the hub — the faces, the sound and any shared screen in its portal
            beside it. Come back here whenever you like.
          </p>
          <Button
            type="button"
            size="sm"
            onClick={dock}
            className="mt-0.5 h-8 gap-1.5 rounded-lg bg-white text-[10px] text-black hover:bg-white/85"
          >
            <Users className="size-3.5" />
            Put the call back in the page
          </Button>
        </div>
        <HeldCallBar call={call} />
      </section>
    );
  }

  return (
    <section className="flex h-full min-h-0 flex-col gap-2.5">
      <p className="shrink-0 px-0.5 text-[11px] font-medium text-muted-foreground">
        {onlineCount} online
      </p>

      {/* A voice call is on, and it has nothing to do with these portals: it is
          in its own box, over whatever you are doing. */}
      {call && onCall && !videoCall ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2 rounded-2xl border border-white/20 bg-white/10 px-3 py-2 backdrop-blur-sm">
          <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-white/15 text-white">
            <Phone className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[11px] font-semibold">
              On a voice call
            </p>
            <p className="truncate text-[9px] text-muted-foreground">
              In its own box, over every page — drag it anywhere.
            </p>
          </div>
        </div>
      ) : null}

      {call ? <HeldCallBar call={call} /> : null}

      {/*
        Two by two, the way the video grid is — but with a floor under each
        row and its own scroll. `grid-rows-2` means `minmax(0, 1fr)`, so on a
        short pane (a phone in landscape, or a narrow frame on a desktop) the
        rows were squeezed below what a portal needs and its "Get on" button
        was simply cut off. With a floor the portal keeps its shape and the
        grid scrolls to reach the rest.
      */}
      <div className="grid min-h-0 flex-1 auto-rows-[minmax(9rem,1fr)] grid-cols-2 gap-3 overflow-y-auto">
        {seats.map((member) => (
          <ContactSeat
            key={member._id}
            member={member}
            onJoin={joinRoom}
            onRing={() => ringOne("video", member._id)}
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

/**
 * A call this tab is not in, but this account still is: a closed tab, a killed
 * browser, or the same account open somewhere else. It is a line, never a panel
 * — the panel used to open over the whole app the moment it was opened, which is
 * exactly what a call nobody made looks like. Either get back on it, or let it
 * go; letting it go does not end it for anyone still on it.
 */
function HeldCallBar({ call }: { call: LiveCall }) {
  const held = call.held;
  if (!held) return null;

  const others = held.people.filter((one) => !one.isMe);

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 rounded-2xl border border-white/20 bg-white/10 px-3 py-2 backdrop-blur-sm">
      <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-white/15 text-white">
        <Phone className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[11px] font-semibold">
          You are still on a call
        </p>
        <p className="truncate text-[9px] text-muted-foreground">
          {held.room ? "The family's room" : `${held.startedByName}'s call`}
          {others.length
            ? ` · ${others.map((one) => one.name).join(", ")} on it`
            : " · nobody else on it"}
        </p>
      </div>
      <Button
        type="button"
        size="sm"
        onClick={call.rejoin}
        className="h-8 gap-1.5 rounded-lg bg-white text-[10px] text-black hover:bg-white/85"
      >
        <Phone className="size-3.5" />
        Get back on
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={call.stepOut}
        className="h-8 gap-1.5 rounded-lg text-[10px]"
      >
        <PhoneOff className="size-3.5" />
        Leave it
      </Button>
    </div>
  );
}

/**
 * One portal: a person, whether they are around, and the three things you can
 * do about them — ring them, get on the call, or take them off the roster.
 */
function ContactSeat({
  member,
  onJoin,
  onRing,
  onRemove,
}: {
  member: FamilyMember;
  onJoin: () => void;
  onRing: () => void;
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
      {/* The ring: their hub rings, buzzes and raises a notification, so a call
          is never something they have to notice by themselves. */}
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label={`Ring ${member.name}`}
        title={
          member.online
            ? `Ring ${member.name} — their hub rings and notifies them`
            : `Ring ${member.name} — they are away, so this rings and notifies them the moment theirs is open`
        }
        onClick={onRing}
        className="absolute left-2 top-2 text-muted-foreground hover:text-foreground"
      >
        <Bell className="size-3.5" />
      </Button>

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
