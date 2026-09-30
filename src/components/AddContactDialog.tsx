import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { copyText } from "@/lib/internal-share";
import { cn } from "@/lib/utils";
import { Check, Copy, Link2, UserPlus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

/**
 * The Add button, opened.
 *
 * Adding a contact here is not a form: everyone who opens this address and
 * signs in joins the same family and shows up in the Messenger on their own. So
 * the only thing a person needs to add someone is the address, in one line,
 * ready to copy and send.
 */
export function AddContactDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [copied, setCopied] = useState(false);

  const address =
    typeof window === "undefined" ? "" : `${window.location.origin}/`;

  const copyInvite = async () => {
    if (await copyText(address)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
      toast.success("Invite copied — send it to the person you want to add.");
    } else {
      toast.error(
        "This browser would not let the hub copy it. Select the address by hand.",
      );
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md rounded-2xl border-border/70 bg-card/95 backdrop-blur-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[13px] font-semibold tracking-tight">
            <UserPlus className="size-4" />
            Add a contact
          </DialogTitle>
          <DialogDescription className="text-[10px] leading-4 text-muted-foreground">
            Send this address to the person you want in the hub. They open it,
            sign in with their own email code, and they are in your family — on
            the roster and in this messenger — from then on.
          </DialogDescription>
        </DialogHeader>

        <div>
          <p className="text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            The address — copy it to them
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-lg border border-border/60 bg-background/40 px-2.5 py-2 text-[10px]">
              {address}
            </code>
            <Button
              type="button"
              variant="outline"
              onClick={() => void copyInvite()}
              aria-label="Copy the invite address"
              className={cn(
                "h-9 shrink-0 cursor-pointer rounded-lg text-[10px]",
                copied && "border-white/40",
              )}
            >
              {copied ? (
                <Check className="size-3.5" />
              ) : (
                <Copy className="size-3.5" />
              )}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </div>

        <ul className="flex flex-col gap-1.5">
          {[
            "They open the address on their own phone or computer and sign in. There is nothing to install and no code to remember.",
            "It is the same hub for everyone — one family, one roster, one room. Nobody outside it can see it.",
            "A code next to their name tells you they are around. Their messages land in this messenger.",
          ].map((line) => (
            <li
              key={line}
              className="flex items-start gap-2 text-[10px] leading-4 text-muted-foreground"
            >
              <span className="mt-1.5 size-1 shrink-0 rounded-full bg-white/60" />
              <span className="min-w-0">{line}</span>
            </li>
          ))}
        </ul>

        <p className="flex items-start gap-2 rounded-lg border border-dashed border-border/70 px-2.5 py-2 text-[10px] leading-4 text-muted-foreground">
          <Link2 className="mt-0.5 size-3 shrink-0" />
          The hub's own browser address book is never given to this app, so
          the roster fills up through this invite, not from your phone.
        </p>
      </DialogContent>
    </Dialog>
  );
}
