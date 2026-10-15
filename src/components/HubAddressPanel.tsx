import { Button } from "@/components/ui/button";
import { api } from "@/convex/_generated/api";
import { ORANGE_GHOST } from "@/lib/control-room-sections";
import { normaliseHubAddress } from "@/lib/hub-address";
import { copyText } from "@/lib/internal-share";
import { useMutation, useQuery } from "convex/react";
import { cn } from "@/lib/utils";
import { Check, Copy, Globe, Loader2, RotateCcw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

/**
 * The hub's own address, and the one place to change it.
 *
 * What the Web Portal shows, and what an invite hands to the next device, is
 * this address rather than whatever origin the page happened to be opened
 * from. Empty means "use this page's own address", which is how the hub behaved
 * before this existed. Owner only — the same account that authorises devices.
 */
export function HubAddressPanel() {
  const stored = useQuery(api.site.address);
  const summary = useQuery(api.security.summary);
  const save = useMutation(api.site.setAddress);

  // The field follows the stored value until it is edited (`draft` is null
  // then), so a change here — or on another device — lands in it without a
  // reload, and nothing is written back to state from an effect.
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const isOwner = summary?.isOwner ?? false;
  const live =
    typeof window === "undefined" ? "" : `${window.location.origin}/`;
  const current = stored ? normaliseHubAddress(stored) : "";
  const shown = current ? `${current}/` : live;
  const value = draft ?? stored ?? "";

  const handleSave = async () => {
    setBusy(true);
    try {
      const clean = await save({ address: value });
      setDraft(null);
      toast.success(
        clean
          ? `The hub now calls itself ${clean}/`
          : "The hub uses this page's own address again.",
      );
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "That address could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  };

  const handleReset = async () => {
    setBusy(true);
    try {
      await save({ address: "" });
      setDraft(null);
      toast.success("The hub uses this page's own address again.");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "That could not be reset.",
      );
    } finally {
      setBusy(false);
    }
  };

  const handleCopy = async () => {
    if (await copyText(shown)) {
      setCopied(true);
      toast.success("Address copied — paste it wherever you like.");
    } else {
      toast.error("This browser would not let me copy it — select it instead.");
    }
  };

  return (
    <section className="rounded-2xl border border-border/70 bg-card/70 p-4 backdrop-blur-sm">
      <div className="flex items-start gap-3">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-white/10 text-white">
          <Globe className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-[9px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            The hub's address
          </h3>
          <p className="mt-1.5 text-[10px] leading-4 text-muted-foreground">
            The one link that opens this hub, shown and copied on the Web Portal
            and handed out with an invite. Set it to the address you actually
            reach the hub on — your own domain, or a name on your network. Leave
            it empty and the hub uses whatever address this page was opened
            from.
          </p>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <input
          readOnly
          value={shown}
          aria-label="The hub's address"
          data-spell="off"
          spellCheck={false}
          onFocus={(event) => event.currentTarget.select()}
          onClick={(event) => event.currentTarget.select()}
          className="min-w-0 flex-1 truncate rounded-lg border border-border/60 bg-background/40 px-2.5 py-2 text-[10px] outline-none focus:border-white/40"
        />
        <Button
          type="button"
          variant="outline"
          onClick={() => void handleCopy()}
          className="h-9 shrink-0 cursor-pointer rounded-lg text-[10px]"
        >
          {copied ? (
            <Check className="size-3.5" />
          ) : (
            <Copy className="size-3.5" />
          )}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>

      {isOwner ? (
        <div className="mt-2 flex items-center gap-2">
          <input
            value={value}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void handleSave();
            }}
            placeholder="http://hub.ranch.com"
            data-spell="off"
            spellCheck={false}
            className="min-w-0 flex-1 rounded-lg border border-border/60 bg-background/40 px-2.5 py-2 text-[10px] outline-none placeholder:text-muted-foreground"
          />
          <Button
            type="button"
            onClick={() => void handleSave()}
            disabled={busy}
            className="h-9 shrink-0 cursor-pointer rounded-lg text-[10px]"
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
            Save
          </Button>
          {current ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => void handleReset()}
              disabled={busy}
              className={cn(
                "h-9 shrink-0 cursor-pointer rounded-lg px-2 text-[10px]",
                ORANGE_GHOST,
              )}
            >
              <RotateCcw className="size-3.5" />
              Use this page
            </Button>
          ) : null}
        </div>
      ) : (
        <p className="mt-2 text-[10px] leading-4 text-muted-foreground">
          Only the hub's owner can change this. Whoever claimed the hub first is
          the owner — see Security above.
        </p>
      )}
    </section>
  );
}
