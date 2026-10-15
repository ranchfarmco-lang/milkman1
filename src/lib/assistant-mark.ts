import { Church } from "lucide-react";

/**
 * The assistant's mark: the one icon that stands for it, everywhere it appears.
 *
 * The little box in the corner is not the only place the assistant is drawn. It
 * is on its own page (`/assistant`), on the tab that opens that page, in the
 * Control Room's tour of the hub, in the Web Portal's list of what is inside,
 * and on the preview half beside its conversation. Six files, and for a while
 * each one named an icon of its own — the corner box carried the sparkle every
 * other assistant on the machine draws, while the page it belongs to wore a
 * mark of its own. Seen side by side, they read as two different things, which
 * is the whole of what an icon is there to prevent.
 *
 * So it is chosen once, here, and read from here everywhere: changing it in this
 * file changes every surface at once, and none of them can quietly drift apart
 * again. `Church` rather than the sparkle, because the sparkle is what every
 * other assistant already looks like and this one is the hub's own.
 */
export const AssistantIcon = Church;
