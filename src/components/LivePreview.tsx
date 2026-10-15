import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Play, RotateCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";

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
 *
 * Three things it can be asked to do, all of them real rather than decorative:
 *
 * * **Device view** — `device="mobile"` puts the page in a 390-pixel frame,
 *   centred, so a layout can be seen at phone width instead of guessed at.
 * * **The element inspector** — with `inspector`, a small script is folded into
 *   the document *before* it is handed over, and it runs inside the frame. It
 *   has to be that way round: the frame has no `allow-same-origin`, so this page
 *   cannot reach into it from outside, and anything that claimed to would be
 *   lying. The script outlines whatever is under the cursor, names it, and on a
 *   press reports the element back here through `postMessage` — the one channel
 *   an opaque origin still has.
 * * **Full screen** is the caller's business: it is a property of whatever box
 *   the frame sits in, so the box owns the element that goes full screen.
 */

/** What the inspector found inside the frame. */
export type InspectorPick = { selector: string; html: string };

/**
 * The script folded into the document while the inspector is on.
 *
 * Everything in here runs inside the sandboxed frame, on the page's own DOM,
 * which is exactly what it is for — this is a tool for looking at the thing you
 * just built, not a way around the frame.
 */
const INSPECTOR_SCRIPT = `
<script>
(function () {
  var HL = document.createElement('div');
  HL.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;border:1px solid #7dd3fc;background:rgba(125,211,252,0.18);border-radius:2px;transition:all 40ms linear;left:0;top:0;width:0;height:0';
  var TAG = document.createElement('div');
  TAG.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;font:10px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:#0b0b0b;color:#e5e5e5;border:1px solid #7dd3fc;border-radius:4px;padding:1px 5px;max-width:60vw;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;left:0;top:0';
  document.documentElement.appendChild(HL);
  document.documentElement.appendChild(TAG);

  function name(el) {
    var text = el.tagName.toLowerCase();
    if (el.id) text += '#' + el.id;
    if (el.classList && el.classList.length) {
      text += '.' + Array.prototype.slice.call(el.classList).slice(0, 3).join('.');
    }
    return text;
  }

  function place(el) {
    var box = el.getBoundingClientRect();
    HL.style.left = box.left + 'px';
    HL.style.top = box.top + 'px';
    HL.style.width = box.width + 'px';
    HL.style.height = box.height + 'px';
    TAG.textContent = name(el) + '  ' + Math.round(box.width) + 'x' + Math.round(box.height);
    TAG.style.left = Math.max(2, Math.min(box.left, window.innerWidth - 140)) + 'px';
    TAG.style.top = (box.top - 18 < 0 ? box.bottom + 4 : box.top - 18) + 'px';
  }

  function clear() {
    HL.style.width = '0';
    HL.style.height = '0';
    TAG.textContent = '';
  }

  document.addEventListener('mouseover', function (event) {
    if (event.target && event.target.tagName) place(event.target);
  }, true);

  document.addEventListener('mouseout', clear, true);

  document.addEventListener('click', function (event) {
    var el = event.target;
    if (!el || !el.tagName) return;
    // The point is to look at the app, not to press its buttons.
    event.preventDefault();
    event.stopPropagation();
    place(el);
    try {
      parent.postMessage({ hubInspector: { selector: name(el), html: el.outerHTML.slice(0, 600) } }, '*');
    } catch (error) {
      /* Nothing to say — the outline is still on screen. */
    }
  }, true);
})();
</script>`;

/** Fold the inspector into a document, before anything of it has run. */
function withInspector(html: string) {
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${INSPECTOR_SCRIPT}\n</body>`);
  return `${html}\n${INSPECTOR_SCRIPT}`;
}

export function LivePreview({
  html,
  label,
  device = "desktop",
  inspector = false,
  onPick,
}: {
  html: string;
  label: string;
  device?: "desktop" | "mobile";
  inspector?: boolean;
  onPick?: (pick: InspectorPick) => void;
}) {
  // Bumping this remounts the frame, which is the honest way to run a page
  // again: the document is reloaded from the top rather than patched.
  const [runs, setRuns] = useState(0);

  // The inspector reports from inside the frame; the callback is read through a
  // ref so a new arrow function on every render does not re-listen each time.
  const pick = useRef(onPick);
  useEffect(() => {
    pick.current = onPick;
  }, [onPick]);

  useEffect(() => {
    if (!inspector) return;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { hubInspector?: InspectorPick } | null;
      if (!data || typeof data !== "object" || !data.hubInspector) return;
      const selector = String(data.hubInspector.selector ?? "").slice(0, 200);
      const picked = String(data.hubInspector.html ?? "").slice(0, 600);
      if (selector) pick.current?.({ selector, html: picked });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [inspector]);

  const doc = inspector ? withInspector(html) : html;

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
        <span className="shrink-0 rounded-full border border-border/60 px-1.5 py-px text-[8px] text-muted-foreground">
          {device === "mobile" ? "390 px" : "full width"}
        </span>
        {inspector ? (
          <span className="shrink-0 rounded-full border border-sky-300/50 px-1.5 py-px text-[8px] text-sky-200/90">
            inspecting
          </span>
        ) : null}
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

      <div
        className={cn(
          "flex min-h-0 flex-1 justify-center",
          device === "mobile" ? "bg-black/30 p-2" : "",
        )}
      >
        <iframe
          key={`${runs}-${device}-${inspector ? "inspect" : "plain"}`}
          title={`Live preview of ${label}`}
          srcDoc={doc}
          sandbox="allow-scripts allow-forms allow-modals allow-popups"
          loading="lazy"
          className={cn(
            "h-full min-h-0 border-0 bg-background",
            device === "mobile"
              ? "w-[390px] max-w-full rounded-xl border border-border/60 shadow-lg"
              : "w-full flex-1",
          )}
        />
      </div>
    </div>
  );
}
