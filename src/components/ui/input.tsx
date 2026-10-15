import * as React from "react";

import { spellsProse } from "@/lib/spellcheck";
import { cn } from "@/lib/utils";

function Input({
  className,
  type,
  spellCheck,
  "data-spell": dataSpell,
  ...props
}: React.ComponentProps<"input"> & { "data-spell"?: "off" }) {
  // Spelling is the browser's own, on every field that holds prose: the words
  // are marked as they are typed and the corrections are a right-click away,
  // exactly as in any other text box on the machine. A field that holds a value
  // rather than sentences — a key, an address, a path — says so once, with
  // `data-spell="off"` or with its own type (password, number, date), and the
  // marker is what the rest of the hub reads too (`src/lib/spellcheck.ts`).
  const prose = spellsProse(type, dataSpell);
  return (
    <input
      type={type}
      data-slot="input"
      data-spell={dataSpell ?? (prose ? undefined : "off")}
      spellCheck={spellCheck ?? prose}
      className={cn(
        "file:text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground dark:bg-input/30 border-input h-9 w-full min-w-0 rounded-md border bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
        "aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
