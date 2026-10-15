/**
 * Finding your way round the Control Room.
 *
 * The page is one long scroll holding every category, its readings, its
 * buttons and its links. The Quick Reference bar pinned to the top is the way
 * round it: every category is a button, all of them on display at once, and
 * pressing one brings that whole category up to the top of the page rather than
 * swapping the page out. Nothing is folded away.
 *
 * Two shared pieces live here so the bar and the page cannot disagree about
 * them: how a heading becomes the id its section carries, and how a button
 * takes the reader to a particular row inside the category.
 */

/**
 * The one look for a button that refreshes a reading or puts something back.
 *
 * Orange belongs to the page's own actions and nothing else: it is never used
 * for a status, so a button in this colour is always safe to press — it
 * re-reads, or it resets something the app itself owns. The connection
 * readings keep their own two colours, green and red, and a warning keeps
 * amber, which is why this is deliberately the button colour and not a status.
 */
export const ORANGE_BUTTON =
  "border-orange-400/45 text-orange-400 hover:border-orange-400/70 hover:bg-orange-400/10 hover:text-orange-300";

/** The same orange, for a small ghost button that refreshes or resets in place. */
export const ORANGE_GHOST =
  "text-orange-400 hover:bg-orange-400/10 hover:text-orange-300";

/** Turn a heading into the id its section carries. */
export const slug = (text: string) =>
  text.toLowerCase().replace(/[^a-z0-9]+/g, "-");

/** Bring one whole section to the top of whatever is scrolling the page. */
export function scrollToSection(id: string) {
  document
    .getElementById(`section-${id}`)
    ?.scrollIntoView({ behavior: "smooth", block: "start" });
}
