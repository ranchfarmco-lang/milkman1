import { useCallApi } from "@/components/CallProvider";
import { Button } from "@/components/ui/button";
import type { FamilyMember } from "@/convex/family";
import { Activity, MessageCircle, Phone, Users, Video } from "lucide-react";

/**
 * The buttons in the messenger header: message, voice call, video call, and the
 * video room. The call panel itself lives in the call provider, so a call
 * started here can be answered from any page.
 */
export function MessengerCall({
  members,
  onMessage,
  onTest,
}: {
  members: FamilyMember[];
  /** Jump straight into the chat box. */
  onMessage?: () => void;
  /** Open the call test, right here in the messenger. */
  onTest?: () => void;
}) {
  const { openPicker, joinRoom } = useCallApi();

  return (
    <>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label="Go to the message box"
        title="Message"
        onClick={onMessage}
        className="shrink-0 text-muted-foreground hover:text-foreground"
      >
        <MessageCircle className="size-3.5" />
      </Button>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label="Start a voice call"
        title="Call someone — voice"
        disabled={members.length === 0}
        onClick={() => openPicker("audio")}
        className="shrink-0 text-muted-foreground hover:text-foreground"
      >
        <Phone className="size-3.5" />
      </Button>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label="Start a video call"
        title="Call someone — video"
        disabled={members.length === 0}
        onClick={() => openPicker("video")}
        className="shrink-0 text-muted-foreground hover:text-foreground"
      >
        <Video className="size-3.5" />
      </Button>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label="Get on the video room"
        title="Video room — get on and wait for the rest"
        onClick={joinRoom}
        className="shrink-0 text-muted-foreground hover:text-foreground"
      >
        <Users className="size-3.5" />
      </Button>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label="Test the camera, microphone and connection"
        title="Test — camera, microphone and the connection between two devices"
        onClick={onTest}
        className="shrink-0 text-muted-foreground hover:text-foreground"
      >
        <Activity className="size-3.5" />
      </Button>
    </>
  );
}

