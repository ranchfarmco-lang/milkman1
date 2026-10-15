import * as React from "react";

import { spellsProse } from "@/lib/spellcheck";
import { cn } from "@/lib/utils";

function Textarea({
  className,
  spellCheck,
  "data-spell": dataSpell,
  ...props
}: React.ComponentProps<"textarea"> & { "data-spell"?: "off" }) {
  // A textarea holds prose, so the browser spells it: the words are marked as
  // they are typed and the correction is a right-click away, as in any other
  // text box on the machine. A field that holds something other than sentences
  // — notes on code, a block of JSON — says so once with `data-spell="off"`
  // (`src/lib/spellcheck.ts`), and an explicit `spellCheck` from the caller
  // still wins.
  const prose = spellsProse(null, dataSpell);
  return (
    <textarea
      data-slot="textarea"
      data-spell={dataSpell ?? (prose ? undefined : "off")}
      spellCheck={spellCheck ?? prose}
      className={cn(
        "border-input placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:bg-input/30 flex field-sizing-content min-h-16 w-full rounded-md border bg-transparent px-3 py-2 text-base shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
