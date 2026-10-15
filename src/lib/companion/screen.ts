/**
 * What is on the screen, written down by the page.
 *
 * The little box that follows the person around is only useful if it knows
 * what they are looking at: "fix it", "how much is this", "make this one
 * shorter" all mean the thing in front of them. So the page describes itself —
 * the route, the heading, the field being typed in and what is in it, and
 * anything selected — and that description travels with each turn.
 *
 * Three rules hold this together:
 *
 *   * **It is a digest, not a picture.** Nothing here captures the screen.
 *     There is no image, no video and no frame grab anywhere in the hub; this
 *     is a few lines of text the page wrote about itself.
 *   * **Nothing secret is written down.** A password field is skipped whole,
 *     and every field is trimmed to a short length before it is kept.
 *   * **It is only ever sent with a turn.** The digest sits in memory for as
 *     long as the tab is open and goes to the model only as part of a question
 *     the person actually asked, or a line it was invited to offer.
 *
 * It lives in a module rather than in React state because the writer (the DOM
 * listeners) and the reader (the companion's own hook) are different trees: the
 * listeners watch the whole document, and the companion is a box in the corner
 * of it. `subscribeScreen` is what lets one hear the other, the same way the
 * dictionary is shared.
 */

import { proseField } from "@/lib/spellcheck";

/** How much of a field's contents is worth keeping. */
const TEXT_LIMIT = 400;
/** How much of a selection is worth keeping. */
const SELECTION_LIMIT = 300;
/** How much of a heading or a label is worth keeping. */
const LABEL_LIMIT = 120;

export type ScreenDigest = {
  /** The route they are on, as the app spells it: "/calendar". */
  path: string;
  /** The page's own heading, when it has one. */
  title: string | null;
  /** What the field they are in is for — its label, placeholder or name. */
  field: string | null;
  /** What they have typed into it so far. */
  text: string | null;
  /** Anything they have highlighted. */
  selection: string | null;
};

let digest: ScreenDigest | null = null;
const listeners = new Set<() => void>();

/** The digest as it stands, or null before the page has written one. */
export function screenSnapshot(): ScreenDigest | null {
  return digest;
}

export function subscribeScreen(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The page writing down what is in front of the person. */
export function writeScreen(next: ScreenDigest | null): void {
  digest = next;
  for (const listener of listeners) listener();
}

/**
 * The digest handed to the model — a handful of lines, or null when there is
 * nothing true to say. Reading this back to the person is forbidden in the
 * prompt; it is context for an answer, never an answer.
 */
export function describeScreen(): string | null {
  const now = digest;
  if (!now) return null;

  const lines = [
    now.title ? `Page: ${now.path} — “${now.title}”` : `Page: ${now.path}`,
  ];

  if (now.field) {
    lines.push(
      now.text
        ? `Focused field: ${now.field} — they have typed: “${now.text}”`
        : `Focused field: ${now.field} — empty so far`,
    );
  }
  if (now.selection) lines.push(`Selected: “${now.selection}”`);

  return lines.join("\n");
}

/** A field's own description of itself, from the nearest thing that says so. */
function labelOf(element: HTMLElement): string | null {
  const direct = element.getAttribute("aria-label")?.trim();
  if (direct) return direct.slice(0, LABEL_LIMIT);

  const placeholder = element.getAttribute("placeholder")?.trim();
  if (placeholder) return placeholder.slice(0, LABEL_LIMIT);

  const name = element.getAttribute("name")?.trim();
  if (name) return name.slice(0, LABEL_LIMIT);

  const labelled = element.getAttribute("aria-labelledby");
  if (labelled) {
    const text = labelled
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
      .filter(Boolean)
      .join(" ");
    if (text) return text.slice(0, LABEL_LIMIT);
  }

  const wrapper = element.closest("label");
  const wrapped = wrapper?.textContent?.trim();
  if (wrapped) return wrapped.slice(0, LABEL_LIMIT);

  return null;
}

/**
 * The field under the caret, and what is in it.
 *
 * A password field is refused outright — and so is any field that is not prose,
 * which is the rule the hub keeps in one place (`proseField` in
 * `src/lib/spellcheck.ts`): a field the browser is not allowed to spell is a
 * field holding a value rather than sentences, and a value — a key, an address,
 * a path — is not something to hand a model either. An empty answer is `null`
 * rather than "a field with nothing in it", so a digest never claims to know
 * about a box it deliberately looked away from.
 */
export function focusedField(): {
  element: HTMLElement;
  label: string | null;
  text: string;
} | null {
  const element = document.activeElement;
  if (!(element instanceof HTMLElement)) return null;
  if (!proseField(element)) return null;

  const field =
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement
      ? element.value
      : (element.textContent ?? "");

  return {
    element,
    label: labelOf(element),
    text: field.slice(0, TEXT_LIMIT),
  };
}

/**
 * Everything on screen, read off the document.
 *
 * Called by the listener hook whenever something changes — a route, the field
 * being typed in, or a selection — and on arrival at a page it has not seen.
 */
export function readScreen(path: string): ScreenDigest {
  const heading =
    document.querySelector<HTMLElement>("[data-companion-title]") ??
    document.querySelector<HTMLElement>("h1");

  const field = focusedField();
  const selected = window.getSelection?.()?.toString().trim() ?? "";

  return {
    path,
    title: heading?.textContent?.trim().slice(0, LABEL_LIMIT) || null,
    field: field?.label ?? null,
    text: field?.text ?? null,
    selection: selected ? selected.slice(0, SELECTION_LIMIT) : null,
  };
}
