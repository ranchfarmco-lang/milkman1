/**
 * Which fields the hub spells, and which it leaves alone.
 *
 * Spelling here is the browser's own — the one every text box on the machine
 * already has. A prose field carries `spellCheck`, so the words are marked as
 * they are typed, the correction is a right-click (or a press) away, and a name
 * that is not in the dictionary can be added to it once and stays added. It
 * needs no dictionary shipped here, no code of ours, and no service: the
 * checker that knows the machine's own words is the one doing the checking.
 *
 * There used to be a checker of this app's own — Hunspell in `nspell`, loaded
 * from `public/spell/`, drawing a mirror of the field over the field and
 * offering corrections under each word from a box of its own. It was the wrong
 * trade in every direction: it could only underline the handful of fields this
 * app knew about, it announced itself with a count in the corner of the box
 * being typed in, and it cost three modules plus half a megabyte of dictionary
 * to be worse than what was already running in the browser. A spelling is worth
 * exactly the underlining it gets in any other text box on the computer.
 *
 * What is left for this module is the one decision that has to be made in one
 * place: which fields those are. Prose is the default — a `<textarea>`, an
 * `<input>` of no type or `text`/`search`, anything contenteditable — so a field
 * added tomorrow is spelled without anybody remembering to ask for it. Anything
 * that holds something other than sentences says so once, with
 * `data-spell="off"`: an address bar, an API key, a file path, a git ref, a code
 * editor.
 *
 * That marker is deliberately not only about spelling. The same note is what
 * keeps a field out of the digest the companion is told about (`screen.ts`): a
 * token or a repository name in a box is not prose to be summarised back either,
 * and two independent lists of "fields to look away from" would eventually
 * disagree. One marker, read by both.
 */

/**
 * The input types that hold prose. Everything else — password, email, number,
 * date, file, url — holds a value, and a value is not spelled.
 */
export const PROSE_INPUT_TYPES = new Set(["text", "search"]);

/**
 * Whether the browser should spell a field of this kind.
 *
 * `type` is the input's own type, or null for a `<textarea>`, which has none and
 * always holds prose. `dataSpell` is the field's `data-spell` attribute — the
 * app's one way of saying "this is not prose", which wins over the type.
 */
export function spellsProse(
  type: string | null | undefined,
  dataSpell?: string | null,
): boolean {
  if (dataSpell === "off") return false;
  // No type at all is a textarea: a box somebody writes sentences in.
  if (type == null) return true;
  return PROSE_INPUT_TYPES.has((type || "text").toLowerCase());
}

/**
 * Whether a field on the page is prose.
 *
 * The same question as `spellsProse`, asked of an element rather than of its
 * properties, so the document-wide readers — the digest the companion is told
 * about — work from the element they actually have in hand.
 */
export function proseField(element: HTMLElement): boolean {
  if (element.dataset.spell === "off") return false;
  if (element instanceof HTMLTextAreaElement) return true;
  if (element instanceof HTMLInputElement) {
    return spellsProse(element.getAttribute("type"));
  }
  return element.isContentEditable;
}
