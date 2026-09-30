import { Button } from "@/components/ui/button";
import { Play, RotateCw } from "lucide-react";
import { useState } from "react";

/**
 * The result, running.
 *
 * A code block tells you what was written; this shows what it does. Whatever
 * the AI produced — a page, a small app off the builder's bench — is handed to
 * a browser and actually rendered here, so a broken layout or a thrown error
 * is visible rather than something you find out after copying it out.
 *
 * The sandbox matters. `allow-scripts` is there because a page with no
 * scripting is not a preview of anything. `allow-same-origin` is deliberately
 * *not* there: without it the document lands in an opaque origin, so the code
 * being shown runs normally but cannot reach this page, its storage, or the
 * signed-in Convex session behind it. That combination is the one that would
 * undo the sandbox, which is why it is absent rather than merely unmentioned.
 *
 * The frame is the hub's own background, not a white sheet. This app is black
 * with white text on purpose, and a bright rectangle in the middle of it reads
 * as a hole rather than as a result. What the *page* inside paints is still the
 * page's own business — anything with a stylesheet of its own draws it exactly
 * as it would in a browser, which is the whole point of running it here — and
 * a fragment that brings no background of its own is given the hub's shell
 * instead, so it is still black-on-white text you can read.
 */
export function LivePreview({ html, label }: { html: string; label: string }) {
  // Bumping this remounts the frame, which is the honest way to run a page
  // again: the document is reloaded from the top rather than patched.
  const [runs, setRuns] = useState(0);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border/60 bg-background/40">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/50 px-2.5 py-1">
        <span className="inline-flex shrink-0 items-center gap-1.5 text-[9px] font-medium tracking-[0.14em] text-muted-foreground uppercase">
          <Play className="size-3" />
          Running
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[9px] text-muted-foreground">
          {label}
        </span>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          onClick={() => setRuns((count) => count + 1)}
          aria-label="Run it again"
          title="Run it again"
          className="size-6 cursor-pointer text-muted-foreground hover:text-foreground"
        >
          <RotateCw className="size-3" />
        </Button>
      </div>

      <iframe
        key={runs}
        title={`Live preview of ${label}`}
        srcDoc={html}
        sandbox="allow-scripts allow-forms allow-modals allow-popups"
        loading="lazy"
        className="min-h-0 w-full flex-1 border-0 bg-background"
      />
    </div>
  );
}
